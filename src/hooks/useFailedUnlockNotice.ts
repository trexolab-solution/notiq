import { useEffect } from "react";
import { useVaultStore } from "../store/vaultStore";
import { showFailedAttemptsNotice } from "../lib/failedAttempts";

/**
 * 0.9.1 — main window only (mounted by VaultDialog): each time the vault goes from locked to unlocked, by any
 * means (this window, the autofill prompt, Windows Hello, a recovery reset), show the one-time "N failed unlock
 * attempts since your last unlock" warning when the backend has one.
 */
export function useFailedUnlockNotice() {
  useEffect(() => useVaultStore.subscribe((s, prev) => {
    if (s.unlocked && !prev.unlocked) void showFailedAttemptsNotice();
  }), []);
}
