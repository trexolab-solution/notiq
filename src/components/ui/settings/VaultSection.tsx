import React, { useEffect, useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { Button } from "../Button";
import { Toggle } from "../Toggle";
import { Select } from "../Select";
import { PasswordInput } from "../PasswordInput";
import { PanicShortcutRow, PasswordGeneratorRow, StorageFolderRow } from "./VaultPrefRows";
import { SessionLockRow } from "./SessionLockRow";
import { toast } from "../../../lib/toast";
import { useAppStore } from "../../../store";
import { useVaultStore } from "../../../store/vaultStore";
import { vaultChangePassword, vaultErrorMessage } from "../../../lib/vault";
import {
  IDLE_OPTIONS, getIdleMinutes, setIdleMinutes, getLockOnHide, setLockOnHide,
} from "../../../lib/vaultPrefs";

const MIN_LEN = 8;

const idleLabel = (m: number) => (m === 0 ? "Never" : m === 1 ? "1 minute" : m === 60 ? "1 hour" : `${m} minutes`);

export const VaultSection = React.memo(function VaultSection() {
  const exists   = useVaultStore((s) => s.exists);
  const unlocked = useVaultStore((s) => s.unlocked);
  useEffect(() => { void useVaultStore.getState().refresh(); }, []);

  const [idle, setIdle]       = useState(() => getIdleMinutes());
  const [onHide, setOnHide]   = useState(() => getLockOnHide());

  const [oldPw, setOldPw]     = useState("");
  const [newPw, setNewPw]     = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (newPw.length < MIN_LEN) { setError(`New password must be at least ${MIN_LEN} characters`); return; }
    if (newPw !== confirmPw)    { setError("New passwords don't match"); return; }
    setBusy(true);
    setError(null);
    try {
      await vaultChangePassword(oldPw, newPw);
      useVaultStore.getState().setUnlocked(true);
      setOldPw(""); setNewPw(""); setConfirmPw("");
      toast.info("Master password changed. Your locked notes and recovery key still work.");
    } catch (err) {
      setError(vaultErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <h2 className="text-base font-semibold text-[var(--color-text)]">Secure Vault</h2>

      {/* Status + primary action */}
      <div className="flex items-center gap-3 p-3.5 rounded-lg bg-[var(--color-bg-tertiary)]">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 text-[var(--color-primary)]"
          style={{ background: "color-mix(in srgb, var(--color-primary) 12%, transparent)" }}
        >
          {unlocked ? <LockOpen size={18} /> : <Lock size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-[var(--color-text)]">
            {!exists ? "Not set up" : unlocked ? "Unlocked" : "Locked"}
          </div>
          <div className="text-xs text-[var(--color-text-muted)]">
            {!exists
              ? "Lock individual notes with a master password. Right-click a tab → Lock with Vault."
              : unlocked
                ? "Locked notes are readable until the vault locks."
                : "Enter your master password to read locked notes."}
          </div>
        </div>
        {!exists && (
          <Button variant="primary" size="sm" onClick={() => void useVaultStore.getState().ensureUnlocked()}>
            Set up vault
          </Button>
        )}
        {exists && !unlocked && (
          <Button variant="primary" size="sm" onClick={() => void useVaultStore.getState().ensureUnlocked()}>
            Unlock
          </Button>
        )}
        {exists && unlocked && (
          <Button variant="ghost" size="sm" onClick={() => void useAppStore.getState().lockVault()}>
            Lock now
          </Button>
        )}
      </div>

      <SettingRow
        label="Auto-lock after inactivity"
        description="Locks the vault when you haven't used the app for this long."
      >
        <Select
          aria-label="Auto-lock timeout"
          value={String(idle)}
          onChange={(v) => { const n = Number(v); setIdle(n); setIdleMinutes(n); }}
          options={IDLE_OPTIONS.map((m) => ({ value: String(m), label: idleLabel(m) }))}
        />
      </SettingRow>

      <SettingRow
        label="Lock when the window is closed"
        description="Closing Notiq hides it in the tray; this locks the vault at that moment."
      >
        <Toggle
          aria-label="Lock when the window is closed"
          value={onHide}
          onChange={(v) => { setOnHide(v); setLockOnHide(v); }}
        />
      </SettingRow>

      <PanicShortcutRow />
      <SessionLockRow />
      <StorageFolderRow />
      <PasswordGeneratorRow />

      {exists && (
        <form onSubmit={changePassword} className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-[var(--color-text)]">Change master password</h3>
          <PasswordInput placeholder="Current password" autoComplete="current-password"
                 value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
          <PasswordInput placeholder="New password" autoComplete="new-password"
                 value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          <PasswordInput placeholder="Confirm new password" autoComplete="new-password"
                 value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
          {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
          <div>
            <Button type="submit" variant="primary" size="sm" disabled={busy || !oldPw || !newPw}>
              {busy ? "Working…" : "Change password"}
            </Button>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Your locked notes don't need re-encrypting, and your recovery key keeps working.
          </p>
        </form>
      )}
    </div>
  );
});
