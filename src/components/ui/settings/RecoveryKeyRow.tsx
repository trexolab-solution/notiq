import { useState } from "react";
import { SettingRow } from "../SettingRow";
import { Button } from "../Button";
import { PasswordInput } from "../PasswordInput";
import { RecoveryKeyDialog } from "../../vault/RecoveryKeyDialog";
import { toast } from "../../../lib/toast";
import { useSyncStatus } from "../../../lib/vaultSync";
import { useVaultStore } from "../../../store/vaultStore";
import { vaultErrorMessage, vaultRotateRecoveryKey } from "../../../lib/vault";

const DESCRIPTION =
  "Replace your recovery key if it may have been seen or lost. The old key stops working for this vault; " +
  "backup files you made before still open with the old key.";

/** 0.9.1 — "Create new recovery key": re-check the master password, then show the new key once. */
export function RecoveryKeyRow() {
  const exists = useVaultStore((s) => s.exists);
  const unlocked = useVaultStore((s) => s.unlocked);
  const synced = !!useSyncStatus()?.enabled;
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);

  const closeForm = () => { setAsking(false); setPassword(""); setError(null); };

  const rotate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!password) { setError("Enter your master password"); return; }
    setBusy(true);
    setError(null);
    try {
      const key = await vaultRotateRecoveryKey(password);
      closeForm();
      setNewKey(key);
    } catch (err) {
      setError(vaultErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const hint = !exists ? "Set up the vault first." : !unlocked ? "Unlock the vault to create a new recovery key." : null;

  return (
    <>
      <SettingRow
        id="vault.password.recovery-key"
        label="Recovery key"
        description={hint ?? DESCRIPTION}
        keywords={["recovery key", "new recovery key", "rotate", "replace", "lost", "reset", "forgot password"]}
      >
        {!asking && (
          <Button className="settings-btn" size="sm" disabled={!exists || !unlocked || busy} onClick={() => setAsking(true)}
                  title={unlocked ? undefined : "Unlock the vault first"}>
            Create new recovery key…
          </Button>
        )}
      </SettingRow>
      {asking && unlocked && (
        <form onSubmit={rotate} className="setting-subform">
          <PasswordInput placeholder="Master password" autoComplete="current-password" autoFocus
                         aria-label="Master password to create a new recovery key"
                         value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="text-xs text-[var(--color-text-muted)]">
            Your current recovery key will stop working for this vault{synced ? ", here and on your other PCs once they sync" : ""}.
            Backup files you made before still open with it.
          </p>
          {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
          <div className="setting-subform-actions">
            <Button className="settings-btn-primary" type="submit" size="sm" variant="primary" disabled={!password}
                    loading={busy} loadingText="Creating…">
              Create new key
            </Button>
            <Button className="settings-btn" type="button" size="sm" disabled={busy} onClick={closeForm}>Cancel</Button>
          </div>
        </form>
      )}
      {newKey && (
        <RecoveryKeyDialog
          recoveryKey={newKey}
          title="Save your new recovery key"
          detail="Your previous recovery key no longer opens this vault, but backup files made before now still open with it. This key is shown once and is not stored anywhere."
          onDone={() => {
            setNewKey(null);
            toast.info("Recovery key replaced. Your master password is unchanged.");
          }}
        />
      )}
    </>
  );
}
