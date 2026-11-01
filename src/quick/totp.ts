/**
 * Quick search 2-step codes: pure helpers (no Tauri). The quick window never holds a TOTP
 * secret: it asks `quick_search_totp` (src-tauri/src/quick_search.rs) for the current code of one
 * entry and counts down locally with the same clock rule as the main editor (`totpRemaining`).
 */
import { totpRemaining } from "../lib/loginEntry";
import type { QuickResult } from "./rank";

/** RFC 6238 step, the same as `totpCode` / `TOTP_PERIOD` in Rust. */
export const TOTP_PERIOD = 30;

/**
 * Below this many seconds left, a copy waits for the next code instead of copying one that may
 * expire before it is pasted (see {@link copyPlan}).
 */
export const NEAR_EXPIRY_SECONDS = 5;

/** How many rows from the top get a live code (about one window's height), plus the selected one. */
export const LIVE_CODE_ROWS = 8;

/** What `quick_search_totp` returns. */
export interface TotpNow {
  code: string;
  /** Seconds the code is still valid (1..=30). */
  remaining: number;
  period: number;
}

/** Index of the TOTP step containing `nowMs`; a code is cached for exactly one step. */
export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_PERIOD);

/** Seconds left in the current step (1..=30), the same as the main editor's countdown. */
export const secondsLeft = (nowMs: number) => totpRemaining(nowMs);

/** Milliseconds until the next step starts. */
export const msUntilNextStep = (nowMs: number) => TOTP_PERIOD * 1000 - (nowMs % (TOTP_PERIOD * 1000));

export type CopyPlan = { kind: "now" } | { kind: "wait"; seconds: number };

/**
 * Copy now, or wait for the next code when fewer than {@link NEAR_EXPIRY_SECONDS} are left.
 *
 * Waiting (instead of copying the *next* code early) always pastes a code that is valid right now:
 * many services accept only the current and the previous step, so a code from the future can be
 * refused. The wait is at most a few seconds and the user then has a full 30 s to paste.
 */
export function copyPlan(remaining: number): CopyPlan {
  return remaining < NEAR_EXPIRY_SECONDS ? { kind: "wait", seconds: Math.max(1, Math.ceil(remaining)) } : { kind: "now" };
}

/**
 * Rels whose live code is worth fetching: 2FA logins among the first `rows` results (what is on
 * screen) plus the selected row, so codes are never computed for the whole vault.
 */
export function codeTargets(results: QuickResult[], sel: number, rows = LIVE_CODE_ROWS): string[] {
  const out: string[] = [];
  results.forEach((r, i) => {
    if (r.totp && r.kind === "login" && (i < rows || i === sel)) out.push(r.rel);
  });
  return out;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Accessible name of a row's code button (no digits: it is read when the button gets focus). */
export const codeLabel = (name: string, seconds: number) => `2FA code for ${name}, ${plural(seconds, "second")} left`;

/** "123456" → "123 456" (display only; the clipboard gets the plain digits). */
export const formatCode = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

/** Footer text while a copy waits for the next code. Never holds the code. */
export const waitingMessage = (seconds: number) => `New 2FA code in ${plural(seconds, "second")}, copying it then…`;
