import type { Lookalike } from "../lib/lookalike";
import {
  decideTrusted, defaultLoginName, indexOfAccount, planSave, type CardMatch, type LoginMatch, type SavePlan, type SaveRequest,
} from "../lib/autofill";

/**
 * The autofill prompt window's state machine, kept pure so every transition is unit-tested.
 * `step(state, event)` returns the next state plus the side effects the window must run, in order
 * (reply to Rust, show / hide the window, scan the vault, release credentials, save a login).
 *
 *   idle ─start─▶ locked ─unlocked─▶ checking ─scanned─▶ request ─allow/deny─▶ idle
 *               └─────────(vault open)────────▶ checking            save ─confirm/deny─▶ idle
 *
 * A trusted site, no match and an unchanged save are answered from `checking` without `show`.
 *
 * Card fills (`fill_card`) take the same path but are never trusted or filled without a pick:
 *   idle ─start─▶ (locked ─unlocked─▶) checking ─cardsScanned─▶ card ─allow/deny─▶ idle
 */

/** `account`: optional vault-relative path the extension asks for (from an earlier `choose` reply). */
export interface FillReq { id: string; host: string; account?: string }
export interface CardReq { id: string; host: string }
export type FillJob = { kind: "fill"; req: FillReq };
export type SaveJob = { kind: "save"; req: SaveRequest };
export type CardJob = { kind: "card"; req: CardReq };
export type Job = FillJob | SaveJob | CardJob;

export type PromptState =
  | { stage: "idle" }
  /** Reading the vault. `silent`: a trusted fill that must not show the window. `consent`: the user just
   *  unlocked in this very prompt (which named the site and the fill), so one clear match is filled without a second Allow. */
  | { stage: "checking"; job: Job; silent: boolean; consent?: boolean }
  | { stage: "locked"; job: Job; error: string | null; busy: boolean }
  | { stage: "request"; job: FillJob; matches: LoginMatch[]; pick: number; trust: boolean; busy: boolean }
  | { stage: "save"; job: SaveJob; plan: SavePlan; name: string; reveal: boolean; busy: boolean }
  /** Pick one of the vault's cards for a checkout page. */
  | { stage: "card"; job: CardJob; cards: CardMatch[]; pick: number; busy: boolean }
  /** A fill from a page that imitates a saved site. Already answered `no_match`; only informs the user. */
  | { stage: "warning"; host: string; lookalike: Lookalike };

export type PromptEvent =
  | { type: "start"; job: Job; exists: boolean; unlocked: boolean; trusted: boolean }
  | { type: "unlockStarted" }
  | { type: "unlockFailed"; error: string | null }
  | { type: "unlocked" }
  | { type: "scanned"; matches: LoginMatch[]; lookalike: Lookalike | null }
  | { type: "cardsScanned"; cards: CardMatch[] }
  | { type: "failed" }
  | { type: "pick"; index: number }
  | { type: "trust"; on: boolean }
  | { type: "name"; value: string }
  | { type: "reveal" }
  | { type: "allow" }
  | { type: "confirmSave"; nameOk: boolean }
  | { type: "answered" }
  | { type: "deny" }
  | { type: "vaultLocked" }
  | { type: "cancel"; id: string };

export type Effect =
  | { kind: "reply"; id: string; payload: unknown }
  | { kind: "show" }
  /** Hide the window (handing the focus back if it was shown) and start the next queued request. */
  | { kind: "finish" }
  | { kind: "scan"; host: string }
  /** List the vault's cards, then dispatch `cardsScanned`. */
  | { kind: "scanCards" }
  /** Look up the credentials of `match`, reply `{ok, …}`, then dispatch `answered`. */
  | { kind: "release"; id: string; match: LoginMatch; trustHost: string | null }
  /** Reply with the picked card's fill data, then dispatch `answered`. */
  | { kind: "releaseCard"; id: string; card: CardMatch }
  /** Write the login, reply `{ok, status}`, then dispatch `answered`. */
  | { kind: "save"; id: string; plan: SavePlan; req: SaveRequest; name: string };

export interface Step { state: PromptState; effects: Effect[] }

export const IDLE: PromptState = { stage: "idle" };

const same = (state: PromptState): Step => ({ state, effects: [] });
const end = (...effects: Effect[]): Step => ({ state: IDLE, effects: [...effects, { kind: "finish" }] });
const reply = (id: string, payload: unknown): Effect => ({ kind: "reply", id, payload });
const scanFor = (job: Job): Effect => (job.kind === "card" ? { kind: "scanCards" } : { kind: "scan", host: job.req.host });

/** The id of the request the window is busy with, if any. */
export function currentId(s: PromptState): string | null {
  return "job" in s ? s.job.req.id : null;
}

export function step(state: PromptState, ev: PromptEvent): Step {
  switch (ev.type) {
    case "start": {
      // One request at a time; the window queues the rest (see `enqueue`).
      if (state.stage !== "idle") return { state, effects: [reply(ev.job.req.id, { error: "denied" })] };
      const { job } = ev;
      // Without a vault there is nothing to unlock here (setting one up happens in Notiq itself).
      if (!ev.exists) return end(reply(job.req.id, { error: "locked" }));
      if (!ev.unlocked) return { state: { stage: "locked", job, error: null, busy: false }, effects: [{ kind: "show" }] };
      // Cards are never trusted: `silent` is for logins only.
      const silent = job.kind === "fill" && ev.trusted;
      return { state: { stage: "checking", job, silent }, effects: [scanFor(job)] };
    }

    case "unlockStarted":
      return state.stage === "locked" ? same({ ...state, busy: true, error: null }) : same(state);
    case "unlockFailed":
      return state.stage === "locked" ? same({ ...state, busy: false, error: ev.error }) : same(state);
    case "unlocked":
      // Trust windows end when the vault locks, so a just-unlocked vault never fills silently. Unlocking
      // here is still an explicit action on a prompt that says what it is for, so it counts as consent
      // (for a login only: a card is always picked in the `card` stage).
      if (state.stage !== "locked") return same(state);
      return { state: { stage: "checking", job: state.job, silent: false, consent: state.job.kind === "fill" }, effects: [scanFor(state.job)] };

    case "cardsScanned": {
      if (state.stage !== "checking" || state.job.kind !== "card") return same(state);
      const job = state.job;
      if (!ev.cards.length) return end(reply(job.req.id, { error: "no_card" }));
      return { state: { stage: "card", job, cards: ev.cards, pick: 0, busy: false }, effects: [{ kind: "show" }] };
    }

    case "scanned": {
      if (state.stage !== "checking" || state.job.kind === "card") return same(state);
      const job = state.job;
      const id = job.req.id;
      if (job.kind === "save") {
        const plan = planSave(ev.matches, job.req);
        if (plan.kind === "unchanged") return end(reply(id, { ok: true, status: "unchanged" }));
        return {
          state: { stage: "save", job, plan, name: defaultLoginName(job.req.title, job.req.host), reveal: false, busy: false },
          effects: [{ kind: "show" }],
        };
      }
      if (!ev.matches.length) {
        if (!ev.lookalike) return end(reply(id, { error: "no_match" }));
        return {
          state: { stage: "warning", host: job.req.host, lookalike: ev.lookalike },
          effects: [reply(id, { error: "no_match" }), { kind: "show" }],
        };
      }
      if (state.silent) {
        const d = decideTrusted(ev.matches, job.req.account);
        if (d.kind === "fill") return { state, effects: [{ kind: "release", id, match: d.match, trustHost: null }] };
        if (d.kind === "choose") return end(reply(id, { choose: d.options }));
        return end(reply(id, { error: "no_match" }));
      }
      if (state.consent) {
        const d = decideTrusted(ev.matches, job.req.account);
        if (d.kind === "fill") return { state, effects: [{ kind: "release", id, match: d.match, trustHost: null }] };
      }
      return {
        state: {
          stage: "request", job, matches: ev.matches, trust: false, busy: false,
          pick: Math.max(0, indexOfAccount(ev.matches, job.req.account)),
        },
        effects: [{ kind: "show" }],
      };
    }

    case "failed":
      return state.stage === "idle" || state.stage === "warning" ? same(state) : end(reply(state.job.req.id, { error: "failed" }));

    case "pick": {
      if ((state.stage !== "request" && state.stage !== "card") || state.busy) return same(state);
      const n = state.stage === "card" ? state.cards.length : state.matches.length;
      return same({ ...state, pick: Math.min(Math.max(0, ev.index), n - 1) });
    }
    case "trust":
      return state.stage === "request" ? same({ ...state, trust: ev.on }) : same(state);
    case "name":
      return state.stage === "save" ? same({ ...state, name: ev.value }) : same(state);
    case "reveal":
      return state.stage === "save" ? same({ ...state, reveal: !state.reveal }) : same(state);

    case "allow": {
      if (state.stage === "card" && !state.busy) {
        const card = state.cards[state.pick];
        if (!card) return same(state);
        return { state: { ...state, busy: true }, effects: [{ kind: "releaseCard", id: state.job.req.id, card }] };
      }
      if (state.stage !== "request" || state.busy) return same(state);
      const match = state.matches[state.pick];
      if (!match) return same(state);
      return {
        state: { ...state, busy: true },
        effects: [{ kind: "release", id: state.job.req.id, match, trustHost: state.trust ? state.job.req.host : null }],
      };
    }
    case "confirmSave":
      if (state.stage !== "save" || state.busy || (state.plan.kind === "create" && !ev.nameOk)) return same(state);
      return {
        state: { ...state, busy: true },
        effects: [{ kind: "save", id: state.job.req.id, plan: state.plan, req: state.job.req, name: state.name }],
      };
    case "answered":
      return state.stage === "idle" ? same(state) : end();

    case "deny":
      switch (state.stage) {
        case "idle": return same(state);
        case "warning": return end();
        // Esc / × while still locked: the vault stays locked, which is what the extension is told.
        case "locked": return state.busy ? same(state) : end(reply(state.job.req.id, { error: "locked" }));
        case "request": case "save": case "card": return state.busy ? same(state) : end(reply(state.job.req.id, { error: "denied" }));
        case "checking": return end(reply(state.job.req.id, { error: "denied" }));
      }
      return same(state);

    case "vaultLocked":
      // Locking cancels an open request (nothing may be released from a locked vault).
      if (state.stage === "checking" || state.stage === "request" || state.stage === "save" || state.stage === "card") {
        return end(reply(state.job.req.id, { error: "locked" }));
      }
      return same(state);

    case "cancel":
      // Rust stopped waiting (timeout): drop the request without replying.
      return currentId(state) === ev.id ? end() : same(state);
  }
}

// ─── Waiting requests ────────────────────────────────────────────────────────

/** Requests that may wait behind the one on screen; more are refused with `denied`. */
export const MAX_QUEUE = 3;

export function enqueue(queue: Job[], job: Job, max = MAX_QUEUE): { queue: Job[]; rejected: Job | null } {
  return queue.length >= max ? { queue, rejected: job } : { queue: [...queue, job], rejected: null };
}

/** Removes a request Rust gave up on (timeout) before it reached the screen. */
export function dropFromQueue(queue: Job[], id: string): Job[] {
  return queue.filter((j) => j.req.id !== id);
}
