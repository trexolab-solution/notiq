import { invoke } from "@tauri-apps/api/core";

/**
 * 0.7.0 — optional, experimental "Unlock with Windows Hello" (src-tauri/src/hello.rs).
 * The master password stays the root secret; Hello is only a convenience unlock.
 */

export interface HelloStatus {
  /** Windows Hello is available on this PC (always false off Windows). */
  supported: boolean;
  /** Hello unlock is turned on for the current vault. */
  enabled: boolean;
}

export const HELLO_OFF: HelloStatus = { supported: false, enabled: false };

/** Never rejects: any failure reads as "unsupported", which hides the feature. */
export const helloStatus = (): Promise<HelloStatus> =>
  invoke<HelloStatus>("hello_status").then(normalizeHelloStatus, () => HELLO_OFF);

/** Needs the vault unlocked; re-checks the master password, then shows Windows Hello prompts. */
export const helloEnable = (password: string) => invoke<void>("hello_enable", { password });
export const helloDisable = () => invoke<void>("hello_disable");
/** Shows the Windows Hello prompt and unlocks the vault on success. */
export const helloUnlock = () => invoke<void>("hello_unlock");

/** Defensive parse of the backend reply: enabled implies supported. */
export function normalizeHelloStatus(s: unknown): HelloStatus {
  if (!s || typeof s !== "object") return HELLO_OFF;
  const o = s as Record<string, unknown>;
  const supported = o.supported === true;
  return { supported, enabled: supported && o.enabled === true };
}

/** Errors the backend phrases as a cancellation; the UI shows them quietly (no red error). */
export function isHelloCancel(msg: string): boolean {
  return /cancel/i.test(msg);
}

/** True when the backend turned Hello off as part of this error (the UI should refresh). */
export function helloWasTurnedOff(msg: string): boolean {
  return /turned off/i.test(msg);
}
