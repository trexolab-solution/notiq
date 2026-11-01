import { invoke } from "@tauri-apps/api/core";
import { toast } from "./toast";

/**
 * 0.9.1 — wrong master passwords / recovery keys entered since the last successful unlock. The backend
 * counts them in `vault-attempts.json` (main window and autofill prompt alike), resets the file on the next
 * successful unlock and hands the count over once through `vault_take_failed_attempts`.
 */
export interface FailedAttempts {
  count: number;
  /** When the most recent one happened, ms since epoch. */
  last_ms: number;
}

export const vaultTakeFailedAttempts = () => invoke<FailedAttempts | null>("vault_take_failed_attempts");

const pad = (n: number) => String(n).padStart(2, "0");
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "today 14:02", "yesterday 09:15", "on 28 Oct 22:40" (the year only when it isn't this one). */
export function attemptTimeLabel(when: Date, now: Date): string {
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const days = Math.round((startOfDay(now) - startOfDay(when)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  const date = when.toLocaleDateString(undefined, {
    day: "numeric", month: "short", ...(when.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  return `on ${date} ${time}`;
}

/** "3 failed unlock attempts since your last unlock · last one today 14:02". */
export function failedAttemptsMessage(a: FailedAttempts, now = new Date()): string {
  const noun = a.count === 1 ? "attempt" : "attempts";
  return `${a.count} failed unlock ${noun} since your last unlock · last one ${attemptTimeLabel(new Date(a.last_ms), now)}`;
}

/** Shows the one-time warning after an unlock, if anything failed before it. Never throws. */
export async function showFailedAttemptsNotice(): Promise<void> {
  try {
    const a = await vaultTakeFailedAttempts();
    if (!a || a.count <= 0) return;
    toast.warning(failedAttemptsMessage(a), {
      id: "vault-failed-attempts",
      source: "Vault",
      detail: "Wrong master passwords or recovery keys were entered on this PC. If that wasn't you, consider changing your master password.",
    });
  } catch (err) {
    console.warn("vault: failed-attempt notice unavailable", err);
  }
}
