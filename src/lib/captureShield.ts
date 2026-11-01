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

/** Narrows an unknown backend value to a mode (pure). */
export function parseCaptureShield(v: unknown): CaptureShieldMode {
  return v === "always" || v === "off" || v === "while_unlocked" ? v : DEFAULT_CAPTURE_SHIELD;
}

export const captureShieldGet = async (): Promise<CaptureShieldMode> =>
  parseCaptureShield(await invoke("capture_shield_get"));
export const captureShieldSet = (mode: CaptureShieldMode) => invoke<void>("capture_shield_set", { mode });
