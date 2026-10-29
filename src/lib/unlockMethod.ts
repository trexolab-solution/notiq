/**
 * Which way the unlock dialog opens with: Windows Hello or the master password. Remembers the
 * method the user last unlocked with. A standalone `localStorage` key (like `lib/firstRun`) so
 * a preferences reset doesn't touch it; it holds no secret.
 */

export type UnlockMethod = "hello" | "password";

const KEY = "vault:unlockMethod";

/** The remembered method, or "hello" when none is stored (Hello being on means the user opted into it). */
export function getUnlockMethod(): UnlockMethod {
  try { return localStorage.getItem(KEY) === "password" ? "password" : "hello"; }
  catch { return "hello"; }
}

export function setUnlockMethod(method: UnlockMethod): void {
  try { localStorage.setItem(KEY, method); }
  catch { /* storage disabled — fall back to the default next time */ }
}
