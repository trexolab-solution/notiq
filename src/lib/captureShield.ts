import { invoke } from "@tauri-apps/api/core";

/**
 * 0.9.1: when the app hides its windows from screenshots, screen recording and screen sharing.
 * Kept by the backend (it creates the windows), so there is no localStorage copy.
 */
export type CaptureShieldMode = "while_unlocked" | "always" | "off";

export const DEFAULT_CAPTURE_SHIELD: CaptureShieldMode = "while_unlocked";

export const CAPTURE_SHIELD_OPTIONS: { value: CaptureShieldMode; label: string }[] = [
  { value: "while_unlocked", label: "While the vault is unlocked" },
  { value: "always", label: "Always" },
  { value: "off", label: "Off" },
];

/** "Off for N minutes": not hidden from capture for a while, then the saved mode applies again. */
export const OFF_MINUTES = [5, 10, 15, 20] as const;

/** Select value of the "Off for N minutes" entries. */
export const offValue = (minutes: number) => `off:${minutes}`;
/** Select value shown while such a period is running. */
export const PAUSED_VALUE = "paused";

/** Narrows an unknown backend value to a mode (pure). */
export function parseCaptureShield(v: unknown): CaptureShieldMode {
  return v === "always" || v === "off" || v === "while_unlocked" ? v : DEFAULT_CAPTURE_SHIELD;
}

export interface CaptureShieldStatus {
  mode: CaptureShieldMode;
  /** End of a running "Off for N minutes" period (ms since the epoch), or null. */
  offUntil: number | null;
}

/** Narrows the backend's status object (pure). */
export function parseCaptureShieldStatus(v: unknown): CaptureShieldStatus {
  const o = (v && typeof v === "object" ? v : {}) as { mode?: unknown; offUntilMs?: unknown };
  const until = typeof o.offUntilMs === "number" && Number.isFinite(o.offUntilMs) ? o.offUntilMs : null;
  return { mode: parseCaptureShield(o.mode), offUntil: until };
}

/** "Off · 7 min left" while such a period runs (rounded up, never below 1) (pure). */
export function pausedLabel(offUntil: number, now = Date.now()): string {
  const min = Math.max(1, Math.ceil((offUntil - now) / 60_000));
  return `Off · ${min} min left`;
}

export const captureShieldGet = async (): Promise<CaptureShieldMode> =>
  parseCaptureShield(await invoke("capture_shield_get"));
export const captureShieldStatus = async (): Promise<CaptureShieldStatus> =>
  parseCaptureShieldStatus(await invoke("capture_shield_status"));
export const captureShieldSet = (mode: CaptureShieldMode) => invoke<void>("capture_shield_set", { mode });
export const captureShieldOffFor = (minutes: number) => invoke<void>("capture_shield_off_for", { minutes });
