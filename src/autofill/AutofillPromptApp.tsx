import { useCallback, useEffect, useRef, useState } from "react";
import { useWindowContextMenu } from "../hooks/useWindowContextMenu";
import type { FormEvent, ReactNode, RefObject } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Copy, CreditCard, FingerprintPattern, IdCard, KeyRound, Lock, ShieldCheck, Timer, TriangleAlert, X } from "lucide-react";
import { DialogButton, DialogFooter, DialogIcon } from "../components/ui/DialogParts";
import { SaveFields } from "../components/vault/autofillBodies";
import {
  cardAllowLabel, cardChoiceItems, CardChoice, fillAllowLabel, FillChoice, IdentityChoice, identityAllowLabel, identityChoiceItems,
  loginChoiceItems, showsSearch, visibleChoices, type ChoiceItem,
} from "../components/vault/autofillChoices";
import { Avatar } from "../components/ui/Avatar";
import { InlineLoading } from "../components/ui/Loading";
import { useVaultUnlock } from "../components/vault/unlock/useVaultUnlock";
import { VaultUnlockActions, VaultUnlockBody } from "../components/vault/unlock/VaultUnlockForm";
import { useDialogBehaviour } from "../components/ui/useDialogBehaviour";
import type { DefaultFocus } from "../components/ui/dialogLogic";
import { applyTheme } from "../lib/themes";
import { resolveVaultDir } from "../lib/vaultDir";
import { ERR_LOCKED, vaultStatus } from "../lib/vault";
import { nameError } from "../lib/vaultTree";
import { LOOKALIKE_REASON_TEXT } from "../lib/lookalike";
import {
  cardReply, clearTrust, fillReply, hasSaveChoice, isFallbackRequest, isTrusted, saveLogin, scanCards, scanLogins, setVaultRootResolver,
  trustHost, validIntent, type SaveRequest,
} from "../lib/autofill";
import { identityReply, scanIdentities, validAccount } from "../lib/autofill";
import { answerList, answerSaveCheck, answerUsernameCopy, copyForExtension, COPY_LABEL, validCopyWhat, type PopupDeps } from "../lib/autofillPopup";
import {
  hasExcludedPasskey, passkeyReply, savePasskey, scanPasskeys, toCreateReq, toGetReq,
} from "../lib/passkeys";
import { PasskeyChoice, PasskeyTargetChoice } from "./PasskeyChoices";
import { EntryDetailsView } from "./EntryDetailsView";
import { fitWindowSize, sizeChanged } from "./fitWindowSize";
import { splitHost } from "./hostParts";
import {
  dropFromQueue, enqueue, IDLE, step, type Effect, type FillReq, type Job, type PromptEvent, type PromptState,
} from "./promptMachine";

/**
 * The browser-autofill approval window (label `autofill-prompt`, route `#/autofill-prompt`).
 *
 * Rust routes every `autofill:request` / `autofill:save` here and never raises the main window.
 * This window stays hidden unless it needs the user: a trusted site, no match or an unchanged save
 * is answered silently. Otherwise it sizes itself to its content, asks Rust to show it (centred,
 * always on top, focused), and after the answer hides again and hands the focus back to the browser.
 * The window lives for the whole session (hidden) so the 5-minute trust windows survive.
 */

const LABEL = "autofill-prompt";
type ThemeId = Parameters<typeof applyTheme>[0];

const reply = (id: string, payload: unknown) => invoke("autofill_reply", { id, payload }).catch(() => {});

/** No file-system access here: just tell the backend where the vault folder is. */
async function promptVaultRoot(): Promise<string> {
  const root = await resolveVaultDir();
  await invoke("vault_set_root", { root });
  return root;
}

const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

/** The toolbar popup's silent requests (list, username copy): no window, no unlock offer. */
const popupDeps: PopupDeps = {
  prepare: promptVaultRoot,
  unlocked: async () => (await vaultStatus()).unlocked,
  scan: async (host) => (await scanLogins(host)).matches,
  lockedError: ERR_LOCKED,
};

export default function AutofillPromptApp() {
  // No text menu here (copies go through the details view's copy buttons): just keep the webview's menu out.
  useWindowContextMenu({ textMenu: false });
  const [state, setState] = useState<PromptState>(IDLE);
  const stateRef = useRef<PromptState>(IDLE);
  const queue = useRef<Job[]>([]);
  /** A request is being processed (from start until `finish`). */
  const active = useRef(false);
  /** The window is on screen (so hiding it should hand the focus back). */
  const shown = useRef(false);
  const fx = useRef<Promise<void>>(Promise.resolve());
  const sized = useRef<{ width: number; height: number } | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  /** The row whose read-only details view is open, for request `id` only (nothing secret is kept here). */
  const [details, setDetails] = useState<{ id: string; index: number } | null>(null);
  /** The chooser's search text, for request `id` only (a new request starts with an empty search). */
  const [query, setQuery] = useState<{ id: string; q: string }>({ id: "", q: "" });

  // ── window size ───────────────────────────────────────────────────────────
  const measure = useCallback(() => {
    const h = (headRef.current?.offsetHeight ?? 0) + (contentRef.current?.offsetHeight ?? 0)
      + (footRef.current?.offsetHeight ?? 0) + 2; // the window's 1px border, top and bottom
    return fitWindowSize(document.documentElement.clientWidth, h);
  }, []);

  const applySize = useCallback(async (recenter: boolean) => {
    const next = measure();
    if (!sizeChanged(sized.current, next)) return;
    sized.current = next;
    const w = getCurrentWindow();
    await w.setSize(new LogicalSize(next.width, next.height)).catch(() => {});
    if (recenter) await w.center().catch(() => {});
  }, [measure]);

  // ── state machine plumbing ────────────────────────────────────────────────
  // `dispatch` is assigned below; effects call back into it.
  const dispatchRef = useRef<(ev: PromptEvent) => void>(() => {});

  const startNext = useCallback(() => {
    const job = queue.current.shift();
    if (job) void startJob(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runEffect = useCallback(async (e: Effect) => {
    const dispatch = dispatchRef.current;
    switch (e.kind) {
      case "reply":
        await reply(e.id, e.payload);
        return;
      case "show":
        // Size to the new content before the window appears, then let Rust centre and focus it.
        await nextTask();
        await applySize(false);
        shown.current = true;
        await invoke("autofill_prompt_show").catch(() => {});
        requestAnimationFrame(() => {
          const a = document.activeElement;
          if (!a || a === document.body) {
            document.querySelector<HTMLElement>("[data-autofocus], [data-dialog-cancel], [data-dialog-default]")?.focus();
          }
        });
        return;
      case "finish":
        if (shown.current) {
          shown.current = false;
          await invoke("autofill_prompt_hide", { restore: true }).catch(() => {});
        }
        active.current = false;
        startNext();
        return;
      case "scan":
        try {
          const { matches, lookalike } = await scanLogins(e.host);
          dispatch({ type: "scanned", matches, lookalike });
        } catch (err) {
          dispatch(err === ERR_LOCKED ? { type: "vaultLocked" } : { type: "failed" });
        }
        return;
      case "scanCards":
        try {
          dispatch({ type: "cardsScanned", cards: await scanCards() });
        } catch (err) {
          dispatch(err === ERR_LOCKED ? { type: "vaultLocked" } : { type: "failed" });
        }
        return;
      case "releaseCard":
        await reply(e.id, cardReply(e.card));
        dispatch({ type: "answered" });
        return;
      case "scanIdentities":
        try {
          dispatch({ type: "identitiesScanned", identities: await scanIdentities() });
        } catch (err) {
          dispatch(err === ERR_LOCKED ? { type: "vaultLocked" } : { type: "failed" });
        }
        return;
      case "releaseIdentity":
        await reply(e.id, identityReply(e.identity));
        dispatch({ type: "answered" });
        return;
      case "release":
        try {
          if (e.trustHost) trustHost(e.trustHost);
          await reply(e.id, e.copy ? await copyForExtension(e.match, e.copy) : await fillReply(e.match, e.intent));
        } catch {
          await reply(e.id, { error: "failed" });
        }
        dispatch({ type: "answered" });
        return;
      // ── passkeys (experimental): Rust makes the key and signs; this window asks and stores ──
      case "scanPasskeyTargets":
        try {
          const [{ matches }, excluded] = await Promise.all([scanLogins(e.host), hasExcludedPasskey(e.rpId, e.exclude)]);
          dispatch({ type: "passkeyTargetsScanned", logins: matches, excluded });
        } catch (err) {
          dispatch(err === ERR_LOCKED ? { type: "vaultLocked" } : { type: "failed" });
        }
        return;
      case "scanPasskeys":
        try {
          dispatch({ type: "passkeysScanned", passkeys: await scanPasskeys(e.rpId, e.allow) });
        } catch (err) {
          dispatch(err === ERR_LOCKED ? { type: "vaultLocked" } : { type: "failed" });
        }
        return;
      case "savePasskey":
        try {
          await savePasskey(e.target, e.req);
          await reply(e.id, { ok: true });
          await emitTo("main", "vault:entries-changed", {}).catch(() => {});
        } catch {
          await reply(e.id, { error: "failed" });
        }
        dispatch({ type: "answered" });
        return;
      case "releasePasskey":
        await reply(e.id, passkeyReply(e.match));
        dispatch({ type: "answered" });
        return;
      case "save":
        try {
          const status = await saveLogin(e.plan, e.req, e.name, { refreshTabs: false });
          await reply(e.id, { ok: true, status });
          // The main window refreshes its vault tree and open tabs.
          await emitTo("main", "vault:entries-changed", {}).catch(() => {});
        } catch {
          await reply(e.id, { error: "failed" });
        }
        dispatch({ type: "answered" });
        return;
    }
  }, [applySize, startNext]);

  const dispatch = useCallback((ev: PromptEvent) => {
    const { state: next, effects } = step(stateRef.current, ev);
    if (next !== stateRef.current) {
      stateRef.current = next;
      flushSync(() => setState(next));
    }
    for (const e of effects) fx.current = fx.current.then(() => runEffect(e)).catch(() => {});
  }, [runEffect]);
  dispatchRef.current = dispatch;

  async function startJob(job: Job) {
    active.current = true;
    let exists = true;
    let unlocked = false;
    try {
      await promptVaultRoot();
      ({ exists, unlocked } = await vaultStatus());
    } catch { /* treat as locked: the user can still unlock here */ }
    const trusted = unlocked && job.kind === "fill" && isTrusted(job.req.host);
    dispatchRef.current({ type: "start", job, exists, unlocked, trusted });
  }

  const accept = useCallback((job: Job) => {
    if (!active.current) { void startJob(job); return; }
    const r = enqueue(queue.current, job);
    queue.current = r.queue;
    if (r.rejected) void reply(r.rejected.req.id, { error: "denied" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── setup: theme, listeners, ready signal ─────────────────────────────────
  useEffect(() => {
    document.documentElement.classList.add("is-autofill-prompt");
    applyTheme((localStorage.getItem("pref:theme") || "dark") as ThemeId);
    setVaultRootResolver(promptVaultRoot);

    let cancelled = false;
    const subs = [
      listen<{ themeId: string }>("theme-changed", (e) => applyTheme(e.payload.themeId as ThemeId)),
      // A global `listen` also hears events Rust sent to the main window; those (fallback) are not ours.
      listen<Omit<FillReq, "intent"> & { intent?: unknown; fallback?: boolean }>("autofill:request", (e) => {
        if (isFallbackRequest(e.payload)) return;
        const { id, host, account } = e.payload;
        const intent = validIntent(e.payload.intent);
        accept({ kind: "fill", req: { id, host, ...(account ? { account } : {}), ...(intent ? { intent } : {}) } });
      }),
      listen<SaveRequest & { fallback?: boolean }>("autofill:save", (e) => {
        if (isFallbackRequest(e.payload)) return;
        const { id, host, url, username, password, title, current } = e.payload;
        accept({ kind: "save", req: { id, host, url, username, password, title, ...(typeof current === "string" && current ? { current } : {}) } });
      }),
      // Should the page offer Save, Update or nothing? Answered silently (no window, no unlock offer).
      listen<{ id: string; host: string; username: string; password: string; current?: unknown }>("autofill:save-check", (e) => {
        const { id, host, username, password, current } = e.payload;
        const req = { host, username, password, ...(typeof current === "string" && current ? { current } : {}) };
        void answerSaveCheck(popupDeps, req).then((r) => reply(id, r));
      }),
      // Card requests come only to this window (Rust has no main-window fallback for them).
      listen<{ id: string; host: string }>("autofill:card", (e) => {
        const { id, host } = e.payload;
        accept({ kind: "card", req: { id, host } });
      }),
      // Identity requests too (prompt window only; `account` only pre-selects the identity).
      listen<{ id: string; host: string; account?: unknown }>("autofill:identity", (e) => {
        const { id, host } = e.payload;
        const account = validAccount(e.payload.account);
        accept({ kind: "identity", req: { id, host, ...(account ? { account } : {}) } });
      }),
      // The toolbar popup (0.9.0). `list` and a username copy are answered silently; a password / code copy is
      // a fill job (same approval: prompt or the site's trust window) whose release copies instead of replying.
      listen<{ id: string; host: string }>("autofill:list", (e) => {
        const { id, host } = e.payload;
        void answerList(popupDeps, host).then((r) => reply(id, r));
      }),
      listen<{ id: string; host: string; account: string; what: unknown }>("autofill:copy", (e) => {
        const { id, host, account } = e.payload;
        const what = validCopyWhat(e.payload.what);
        if (!what || !account) { void reply(id, { error: "bad_request" }); return; }
        if (what === "username") { void answerUsernameCopy(popupDeps, host, account).then((r) => reply(id, r)); return; }
        accept({ kind: "fill", req: { id, host, account, copy: what, ...(what === "code" ? { intent: "code" as const } : {}) } });
      }),
      // Passkeys (experimental): prompt window only, always asked (Rust never routes them to the main window).
      listen<Record<string, unknown>>("autofill:passkey-create", (e) => {
        const req = toCreateReq(e.payload);
        if (!req) { if (typeof e.payload.id === "string") void reply(e.payload.id, { error: "bad_request" }); return; }
        accept({ kind: "passkeyCreate", req });
      }),
      listen<Record<string, unknown>>("autofill:passkey-get", (e) => {
        const req = toGetReq(e.payload);
        if (!req) { if (typeof e.payload.id === "string") void reply(e.payload.id, { error: "bad_request" }); return; }
        accept({ kind: "passkeyGet", req });
      }),
      listen<{ id: string }>("autofill:cancel", (e) => {
        queue.current = dropFromQueue(queue.current, e.payload.id);
        dispatch({ type: "cancel", id: e.payload.id });
      }),
      listen("autofill-prompt:dismiss", () => dispatch({ type: "deny" })),
      listen<{ unlocked: boolean; source?: string }>("vault:state-changed", (e) => {
        if (!e.payload.unlocked) {
          clearTrust();
          setDetails(null); // drop the details view (and everything it read) at once, not only with the request
          dispatch({ type: "vaultLocked" });
        } else if (e.payload.source !== LABEL) {
          dispatch({ type: "unlocked" }); // unlocked in the main window while this one asked for the password
        }
      }),
      // Closing the main window to the tray ends every trust window (as before).
      listen("vault-window-hidden", () => clearTrust()),
    ];
    // Ready only once every listener is registered.
    void Promise.all(subs).then(() => { if (!cancelled) void invoke("autofill_ui_ready").catch(() => {}); });
    return () => {
      cancelled = true;
      subs.forEach((p) => p.then((un) => un()).catch(() => {}));
    };
  }, [accept, dispatch]);

  // Follow content changes while on screen (an error line, a longer list).
  useEffect(() => {
    const ro = new ResizeObserver(() => { if (shown.current) void applySize(true); });
    [headRef, contentRef, footRef].forEach((r) => { if (r.current) ro.observe(r.current); });
    return () => ro.disconnect();
  }, [state, applySize]);

  if (state.stage === "idle" || (state.stage === "checking" && state.silent)) {
    // Nothing to show (the window is hidden, or about to be).
    return <div className="af-window" aria-hidden />;
  }

  const refs = { headRef, contentRef, footRef };
  const deny = () => dispatch({ type: "deny" });

  // ── details sub-view (logins, cards, identities) ──────────────────────────
  const reqId = "job" in state ? state.job.req.id : null;
  const viewing = details && details.id === reqId ? details.index : null;
  const openDetails = (index: number) => { if (reqId) setDetails({ id: reqId, index }); };
  const closeDetails = () => {
    const index = viewing;
    setDetails(null);
    // Back on the list: put the focus on the row's details button again.
    if (index !== null) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-af-details="${index}"]`)?.focus());
  };
  /** "Open in Notiq": the main window opens the entry; this request ends as denied (nothing is filled). */
  const openInNotiq = async (rel: string) => {
    const wasShown = shown.current;
    shown.current = false; // Rust hides the window itself, handing the focus to the main window, not the browser
    try {
      await invoke("autofill_prompt_open_entry", { rel });
    } catch {
      shown.current = wasShown;
      return;
    }
    setDetails(null);
    dispatch({ type: "deny" });
  };
  // ── chooser stages (logins, cards, identities) ────────────────────────────
  const q = query.id === reqId ? query.q : "";
  const onQuery = (value: string) => { if (reqId) setQuery({ id: reqId, q: value }); };
  const onPick = (index: number) => dispatch({ type: "pick", index });
  /** Enter / double-click on a row and "Fill this login" in the details view: the same as picking the row, then Allow. */
  const pickAndAllow = (index: number) => { dispatch({ type: "pick", index }); dispatch({ type: "allow" }); };

  const chooser = (o: {
    key: string; host: string; kind: Kind; trustNote: ReactNode; items: ChoiceItem[];
    entries: { path: string; rel?: string }[]; busy: boolean; allowLabel: string; busyText: string; fillLabel: string;
    list: ReactNode;
  }) => {
    const at = viewing;
    const viewed = at !== null ? o.entries[at] : undefined;
    // The search hides every row: there is nothing on screen to allow.
    const nothing = showsSearch(o.items.length) && visibleChoices(o.items, q).length === 0;
    return (
      <Panel key={o.key} refs={refs} host={o.host} icon="site" kind={o.kind} sub="Asked by the Notiq browser extension"
             onClose={deny} onEscape={viewed ? closeDetails : undefined} defaultFocus="cancel"
             footer={viewed ? null : <>
               <DialogButton cancel onClick={deny} disabled={o.busy}>Deny</DialogButton>
               <DialogButton variant="primary" className="af-allow" title={o.allowLabel} disabled={nothing} loading={o.busy}
                             loadingText={o.busyText} onClick={() => dispatch({ type: "allow" })}>
                 <span className="af-allow-label">{o.allowLabel}</span>
               </DialogButton>
             </>}>
        {viewed && at !== null ? (
          <EntryDetailsView key={viewed.path} path={viewed.path} title={o.items[at]?.title} onBack={closeDetails} busy={o.busy}
                            fillLabel={o.fillLabel} onFill={() => pickAndAllow(at)}
                            onOpen={viewed.rel ? () => void openInNotiq(viewed.rel!) : undefined} />
        ) : <>
          <div className="dlg-callout af-trust-note">
            <ShieldCheck size={14} className="shrink-0 mt-0.5" aria-hidden />
            <span>{o.trustNote}</span>
          </div>
          {o.list}
        </>}
      </Panel>
    );
  };

  switch (state.stage) {
    case "checking":
      // Only seen right after an unlock in this window, while the vault is read (usually a blink).
      return (
        <Panel key={`checking-${state.job.req.id}`} refs={refs} host={state.job.req.host} icon="shield" onClose={deny}
               sub="Vault unlocked." footer={<DialogButton cancel onClick={deny}>Cancel</DialogButton>}>
          <InlineLoading delay={0} className="af-state"
                         label={state.job.kind === "card" ? "Looking for saved cards…"
                           : state.job.kind === "identity" ? "Looking for saved identities…"
                           : state.job.kind === "passkeyGet" ? "Looking for saved passkeys…" : "Looking for saved logins for this site…"} />
        </Panel>
      );
    case "locked":
      return <LockedStage key={`locked-${state.job.req.id}`} refs={refs} job={state.job} dispatch={dispatch} onDeny={deny} />;
    case "request": {
      const { job, matches, pick, trust, busy } = state;
      const { copy, intent } = job.req;
      return chooser({
        key: `request-${job.req.id}`, host: job.req.host, busy, entries: matches, items: loginChoiceItems(matches),
        kind: copy ? { icon: <Copy size={11} />, label: `Copy ${COPY_LABEL[copy]}` }
          : intent === "code" ? { icon: <Timer size={11} />, label: "2-step code" } : { icon: <KeyRound size={11} />, label: "Login" },
        trustNote: copy ? "Only allow this if you just pressed Copy in the Notiq extension." : "Only allow this if you just pressed Fill on this site.",
        allowLabel: fillAllowLabel(matches[pick], job.req), busyText: copy ? "Copying…" : "Filling…",
        fillLabel: copy ? `Copy the ${COPY_LABEL[copy]}` : intent === "code" ? "Fill this code" : "Fill this login",
        list: (
          <FillChoice host={job.req.host} matches={matches} pick={pick} disabled={busy} onPick={onPick} onAllow={pickAndAllow}
                      onDetails={openDetails} query={q} onQuery={onQuery}
                      trust={trust} onTrust={(on) => dispatch({ type: "trust", on })} />
        ),
      });
    }
    case "card": {
      const { job, cards, pick, busy } = state;
      return chooser({
        key: `card-${job.req.id}`, host: job.req.host, busy, entries: cards, items: cardChoiceItems(cards),
        kind: { icon: <CreditCard size={11} />, label: "Payment card" },
        trustNote: <>Only allow this if you just pressed Fill on this site&rsquo;s checkout.</>,
        allowLabel: cardAllowLabel(cards[pick]), busyText: "Filling…", fillLabel: "Fill this card",
        list: (
          <CardChoice cards={cards} pick={pick} disabled={busy} onPick={onPick} onAllow={pickAndAllow} onDetails={openDetails}
                      query={q} onQuery={onQuery} />
        ),
      });
    }
    case "identity": {
      const { job, identities, pick, busy } = state;
      return chooser({
        key: `identity-${job.req.id}`, host: job.req.host, busy, entries: identities, items: identityChoiceItems(identities),
        kind: { icon: <IdCard size={11} />, label: "Identity" },
        trustNote: <>
          Your name, email, phone and address go to <strong className="af-host-inline">{job.req.host}</strong>. Only allow this
          if you just asked to fill a form there.
        </>,
        allowLabel: identityAllowLabel(identities[pick]), busyText: "Filling…", fillLabel: "Fill with this identity",
        list: (
          <IdentityChoice identities={identities} pick={pick} disabled={busy} onPick={onPick} onAllow={pickAndAllow}
                          onDetails={openDetails} query={q} onQuery={onQuery} />
        ),
      });
    }
    case "save": {
      const { job, plan, name, reveal, busy } = state;
      const update = plan.kind === "update";
      const nameErr = update ? null : nameError(name);
      const confirm = () => dispatch({ type: "confirmSave", nameOk: !nameErr });
      const choice = hasSaveChoice(plan);
      return (
        <Panel key={`save-${job.req.id}`} refs={refs} host={job.req.host} icon={<KeyRound size={16} />}
               sub={update ? "The Notiq extension wants to update a saved password." : "The Notiq extension wants to save a new login."}
               onClose={deny}
               footer={<>
                 <DialogButton cancel onClick={deny} disabled={busy}>Not now</DialogButton>
                 {update && choice && (
                   <DialogButton disabled={busy} onClick={() => dispatch({ type: "saveAsNew", on: true })}>Save as new</DialogButton>
                 )}
                 <DialogButton variant="primary" disabled={!!nameErr} loading={busy} loadingText={update ? "Updating…" : "Saving…"}
                               onClick={confirm}>{update ? "Update" : "Save"}</DialogButton>
               </>}>
          <p className="af-detail">Only save it if you just signed in on this site.</p>
          <SaveFields req={job.req} plan={plan} name={name} nameError={nameErr} reveal={reveal} disabled={busy}
                      onName={(value) => dispatch({ type: "name", value })} onReveal={() => dispatch({ type: "reveal" })}
                      onTarget={(index) => dispatch({ type: "saveTarget", index })}
                      onSaveAsNew={(on) => dispatch({ type: "saveAsNew", on })}
                      onEnter={confirm} />
        </Panel>
      );
    }
    case "passkeyCreate": {
      const { job, logins, pick, excluded, busy } = state;
      const who = job.req.userName || job.req.displayName;
      if (excluded) {
        return (
          <Panel key={`passkey-create-${job.req.id}`} refs={refs} host={job.req.host} icon={<FingerprintPattern size={16} />}
                 sub={`Save a passkey for ${job.req.rpId}?`} onClose={deny} defaultFocus="cancel"
                 footer={<>
                   <DialogButton cancel onClick={deny}>Cancel</DialogButton>
                   <DialogButton variant="primary" onClick={() => dispatch({ type: "allow" })}>OK</DialogButton>
                 </>}>
            <p className="af-detail">
              Notiq already has a passkey for {who ? <strong>{who}</strong> : "this account"} on {job.req.rpId}. Nothing new
              is saved. Press OK to tell the site, or Cancel to use another passkey from your browser instead.
            </p>
          </Panel>
        );
      }
      return (
        <Panel key={`passkey-create-${job.req.id}`} refs={refs} host={job.req.host} icon={<FingerprintPattern size={16} />}
               sub={`Save a passkey for ${job.req.rpId}?`} onClose={deny} defaultFocus="cancel"
               footer={<>
                 <DialogButton cancel onClick={deny} disabled={busy}>Not now</DialogButton>
                 <DialogButton variant="primary" loading={busy} loadingText="Saving…" onClick={() => dispatch({ type: "allow" })}>Save passkey</DialogButton>
               </>}>
          <p className="af-detail">
            The Notiq extension wants to save a new passkey{who ? <> for <strong>{who}</strong></> : null} in your vault
            (experimental). Only save it if you just chose to create a passkey on this site.
          </p>
          <PasskeyTargetChoice logins={logins} pick={pick} disabled={busy} onPick={(index) => dispatch({ type: "pick", index })} />
        </Panel>
      );
    }
    case "passkeyGet": {
      const { job, passkeys, pick, busy } = state;
      return (
        <Panel key={`passkey-get-${job.req.id}`} refs={refs} host={job.req.host} icon={<FingerprintPattern size={16} />}
               sub={`Sign in to ${job.req.rpId} with a passkey?`} onClose={deny} defaultFocus="cancel"
               footer={<>
                 <DialogButton cancel onClick={deny} disabled={busy}>Deny</DialogButton>
                 <DialogButton variant="primary" loading={busy} loadingText="Signing in…" onClick={() => dispatch({ type: "allow" })}>Sign in</DialogButton>
               </>}>
          <p className="af-detail">Only allow this if you just chose to sign in with a passkey on this site.</p>
          <PasskeyChoice passkeys={passkeys} pick={pick} disabled={busy} onPick={onPick} onAllow={pickAndAllow} />
        </Panel>
      );
    }
    case "warning":
      return (
        <Panel key={`warning-${state.host}`} refs={refs} host={state.host} icon={<TriangleAlert size={16} />} tone="danger"
               sub="Notiq did not fill this page." onClose={deny}
               footer={<DialogButton variant="primary" onClick={deny}>OK</DialogButton>}>
          <div className="dlg-callout dlg-callout--danger" role="alert">
            <TriangleAlert size={14} className="shrink-0 mt-0.5" aria-hidden />
            <span>
              This may be a fake site: it looks like <strong>{state.lookalike.saved}</strong>, which you have a login for,
              but it {LOOKALIKE_REASON_TEXT[state.lookalike.reason]}.
            </span>
          </div>
          <p className="af-detail">Nothing was sent to the page. Check the address before you type a password.</p>
        </Panel>
      );
  }
}

// ── pieces ──────────────────────────────────────────────────────────────────

interface Refs {
  headRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  footRef: RefObject<HTMLDivElement>;
}

interface PanelProps {
  refs: Refs;
  host: string;
  sub: ReactNode;
  /** "site": the site's letter avatar, with `kind` (what will be filled) as its badge and as a chip. */
  icon: "shield" | "site" | ReactNode;
  kind?: Kind;
  tone?: "primary" | "danger";
  onClose: () => void;
  /** Escape does this instead of `onClose` (e.g. back from a details view); the close button still closes. */
  onEscape?: () => void;
  defaultFocus?: DefaultFocus;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  /** null: no footer (the details view has its own actions). */
  footer: ReactNode | null;
  children: ReactNode;
}

/** What a request will fill, for the header ("Login", "Payment card"…). */
interface Kind { icon: ReactNode; label: string }

/** The whole window as one dialog: site header, scrolling body, footer. Esc / × = deny. */
function Panel({ refs, host, sub, icon, kind, tone = "primary", onClose, onEscape, defaultFocus, onSubmit, footer, children }: PanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  useDialogBehaviour(panelRef, { onClose: onEscape ?? onClose, dismissable: true, autoFocus: true, defaultFocus });
  const { prefix, site } = splitHost(host);
  const inner = (
    <>
      <div ref={refs.headRef} className="af-head" data-tauri-drag-region>
        {icon === "site" ? <Avatar name={site} size={36} badge={kind?.icon} className="af-site-avatar" />
          : icon === "shield" ? <DialogIcon kind="shield" /> : <DialogIcon tone={tone}>{icon}</DialogIcon>}
        <div className="af-head-text" data-tauri-drag-region>
          <h1 className="af-host" id="af-title" title={host}>
            {prefix && <span className="af-host-prefix">{prefix}</span>}{site}
          </h1>
          <p className="af-sub" id="af-desc" data-tauri-drag-region>
            {kind && <span className="af-kind">{kind.icon}{kind.label}</span>}
            {kind && <span className="sr-only">: </span>}
            {sub}
          </p>
        </div>
        <button type="button" className="dlg-close" aria-label="Close" onClick={onClose}>
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
      <div className="af-scroll">
        <div ref={refs.contentRef} className="af-content">{children}</div>
      </div>
      <div ref={refs.footRef}>
        {footer != null && <DialogFooter>{footer}</DialogFooter>}
      </div>
    </>
  );
  const common = {
    ref: panelRef as never,
    className: "af-window",
    role: "alertdialog" as const,
    "aria-modal": true,
    "aria-labelledby": "af-title",
    "aria-describedby": "af-desc",
    tabIndex: -1,
  };
  return onSubmit ? <form {...common} onSubmit={onSubmit}>{inner}</form> : <div {...common}>{inner}</div>;
}

interface LockedProps {
  refs: Refs;
  job: Job;
  dispatch: (ev: PromptEvent) => void;
  onDeny: () => void;
}

/** The vault is locked: the same unlock form as the main window (master password or Windows Hello). */
function LockedStage({ refs, job, dispatch, onDeny }: LockedProps) {
  const u = useVaultUnlock({
    onUnlocked: () => dispatch({ type: "unlocked" }),
    onStart: () => dispatch({ type: "unlockStarted" }),
    onFail: (error) => dispatch({ type: "unlockFailed", error }),
    // The Windows Hello dialog must not open underneath this always-on-top window.
    beforeHello: () => getCurrentWindow().setAlwaysOnTop(false).catch(() => {}),
    afterHello: async () => {
      const win = getCurrentWindow();
      await win.setAlwaysOnTop(true).catch(() => {});
      await win.setFocus().catch(() => {});
    },
  });
  const copy = job.kind === "fill" ? job.req.copy : undefined;
  const what = copy ? `copy the ${COPY_LABEL[copy]} of a saved login`
    : job.kind === "fill" ? (job.req.intent === "code" ? "fill a 2FA code" : "fill a saved login")
    : job.kind === "card" ? "fill a payment card" : job.kind === "identity" ? "fill your details (identity)"
    : job.kind === "passkeyCreate" ? `save a passkey for ${job.req.rpId}`
    : job.kind === "passkeyGet" ? `sign in to ${job.req.rpId} with a passkey` : "save a login";
  const submitLabel = copy ? "Unlock & copy" : job.kind === "fill" ? "Unlock & fill" : job.kind === "card" ? "Unlock & pick card"
    : job.kind === "identity" ? "Unlock & pick identity" : job.kind === "passkeyGet" ? "Unlock & continue"
    : job.kind === "passkeyCreate" ? "Unlock & continue" : "Unlock & save";
  const purpose = copy ? "unlock and copy it" : job.kind === "fill" ? "unlock and fill it" : job.kind === "card" ? "unlock and pick a card"
    : job.kind === "identity" ? "unlock and pick an identity" : job.kind === "passkeyGet" ? "unlock and pick a passkey"
    : job.kind === "passkeyCreate" ? "unlock and save the passkey" : "unlock and save it";
  return (
    <Panel refs={refs} host={job.req.host} icon={<Lock size={16} />} onClose={onDeny} onSubmit={u.submit}
           sub={`The Notiq extension wants to ${what}.`}
           footer={<VaultUnlockActions u={u} onCancel={onDeny} submitLabel={submitLabel} />}>
      <VaultUnlockBody u={u} purpose={purpose} idPrefix="af-unlock" />
    </Panel>
  );
}
