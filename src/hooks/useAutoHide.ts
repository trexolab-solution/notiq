import { useEffect } from "react";
import { getAutoHideSeconds } from "../lib/vaultPrefs";

/** Window event: hide every revealed secret now (fired when a session lock couldn't lock the vault). */
export const VAULT_HIDE_SECRETS_EVENT = "vault:hide-secrets";

/**
 * Arms the hide triggers (timer, blur, hidden page, hide-secrets event) and returns a disposer.
 * Pure of React so it can be unit-tested with fake timers and a plain EventTarget.
 */
export function armAutoHide(
  hide: () => void,
  seconds: number,
  win: EventTarget,
  doc: { visibilityState: string } & EventTarget,
): () => void {
  const timer = seconds > 0 ? setTimeout(hide, seconds * 1000) : undefined;
  const onVis = () => { if (doc.visibilityState === "hidden") hide(); };
  win.addEventListener("blur", hide);
  win.addEventListener(VAULT_HIDE_SECRETS_EVENT, hide);
  doc.addEventListener("visibilitychange", onVis);
  return () => {
    if (timer) clearTimeout(timer);
    win.removeEventListener("blur", hide);
    win.removeEventListener(VAULT_HIDE_SECRETS_EVENT, hide);
    doc.removeEventListener("visibilitychange", onVis);
  };
}

/**
 * Hides a revealed secret again: after the configured number of seconds
 * (Settings → Vault; 0 = never), immediately when the window loses focus or
 * becomes hidden, and when a session lock asks for it. Pass any state setter.
 */
export function useAutoHide(shown: boolean, setShown: (v: boolean) => void) {
  useEffect(() => {
    if (!shown) return;
    return armAutoHide(() => setShown(false), getAutoHideSeconds(), window, document);
  }, [shown, setShown]);
}
