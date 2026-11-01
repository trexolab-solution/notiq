import { useEffect, useState } from "react";
import { KeyRound, Lock, Copy, Printer, Cloud, ShieldPlus } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogCheckbox, DialogFooter } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { PasswordInput } from "../ui/PasswordInput";
import { Button } from "../ui/Button";
import { RestoreBackupDialog } from "./RestoreBackupDialog";
import { RecoveryKitDialog } from "./RecoveryKitDialog"; // 0.7.0 recovery kit
import { SyncSetupHost } from "./sync/SyncSetupHost";
import { SyncOnboardingDialog } from "./sync/SyncOnboardingDialog";
import { useSyncStatus, useSyncStore } from "../../lib/vaultSync";
import { isCreatingForSync, startSyncSetup } from "../../lib/syncSetupFlow";
import { shouldOfferSyncOnboarding } from "../../lib/syncLifecycle";
import { initVaultSyncEvents } from "../../lib/vaultSyncEvents";
import { toast } from "../../lib/toast";
import { initVaultStateSync, useVaultStore, type VaultDialogMode } from "../../store/vaultStore";
import { useAppStore } from "../../store";
import { useVaultAutoLock } from "../../hooks/useVaultAutoLock";
import { useVaultSessionLock } from "../../hooks/useVaultSessionLock";
import { copySecretTimed } from "../../lib/secureCopy";
import { clipboardClearLabel } from "../../lib/vaultPrefs";
import { vaultCreate, vaultUnlockWithRecovery, vaultErrorMessage } from "../../lib/vault";
import { useVaultUnlock } from "./unlock/useVaultUnlock";
import { VaultUnlockActions, VaultUnlockBody } from "./unlock/VaultUnlockForm";

import { masterPasswordProblem } from "../../lib/masterPassword";
import { PasswordStrengthMeter } from "./PasswordStrengthMeter";

/** Mounted once (AppOverlays). Renders the setup / unlock / recover dialog. */
export function VaultDialog() {
  const mode = useVaultStore((s) => s.dialog);
  useEffect(() => { void useVaultStore.getState().refresh(); }, []);
  // Follow an unlock done in the autofill prompt window (and its saved logins).
  useEffect(() => initVaultStateSync("main"), []);
  // Vault Sync: live status, the one conflict notification, refreshing after remote changes.
  useEffect(() => initVaultSyncEvents(), []);
  // This component is mounted once for the whole app, so it also hosts the
  // vault's global behaviour (idle / close-to-tray auto-lock).
  useVaultAutoLock();
  useVaultSessionLock();
  // After creating a NEW vault: the optional "Use this vault on your other PCs?" step. It lives here (not in
  // the setup dialog) so the setup finishes — and whoever waited for the vault continues — first.
  const [offerSync, setOfferSync] = useState(false);
  // key={mode} remounts on mode switch so passwords never leak between steps.
  return (
    <>
      {mode === "unlock" ? <UnlockDialog key={mode} />
        : mode ? <VaultDialogInner key={mode} mode={mode} onCreated={() => setOfferSync(true)} /> : null}
      {offerSync && !mode && <SyncOnboardingDialog onClose={() => setOfferSync(false)} />}
      {/* Vault Sync setup steps (connect → Drive check → open / create / upload / two vaults). */}
      <SyncSetupHost />
    </>
  );
}

const succeed = async () => {
  useVaultStore.getState().setUnlocked(true);
  await useAppStore.getState().unlockVaultTabs();
  useVaultStore.getState().finish(true);
};
const cancel = () => useVaultStore.getState().finish(false);

/** The unlock step: the same form as the autofill window (master password or Windows Hello). */
function UnlockDialog() {
  const u = useVaultUnlock({ onUnlocked: succeed });
  return (
    <Dialog onClose={cancel} zClassName="z-[70]" size="sm" onSubmit={u.submit} title="Unlock vault" icon={<Lock size={16} />}>
      <DialogBody>
        <VaultUnlockBody u={u} purpose="open locked notes" idPrefix="vault-unlock" />
      </DialogBody>
      <DialogFooter
        start={
          <button type="button" className="dlg-link" onClick={() => useVaultStore.getState().setDialog("recover")}>
            Forgot password?
          </button>
        }
      >
        <VaultUnlockActions u={u} onCancel={cancel} submitLabel="Unlock" />
      </DialogFooter>
    </Dialog>
  );
}

type SetupMode = Exclude<VaultDialogMode, "unlock" | null>;

/** Setting up a new vault, or resetting the master password with the recovery key. */
function VaultDialogInner({ mode, onCreated }: { mode: SetupMode; onCreated?: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm]   = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After setup succeeds we show the recovery key once.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [showKit, setShowKit] = useState(false); // 0.7.0 recovery kit
  // Hide "Use my vault from Google Drive" only once we know this build has no Google sign-in.
  const syncStatus = useSyncStatus();
  // Opened by the sync flow's "Create a new vault" (Drive is known to be empty): no Drive card, and sync turns on
  // by itself afterwards instead of asking "Use this vault on your other PCs?".
  const [forSync] = useState(isCreatingForSync);
  const driveAvailable = syncStatus?.configured !== false && !forSync;

  const validate = (): string | null => {
    const weak = masterPasswordProblem(password);
    if (weak) return weak;
    if (password !== confirm) return "Passwords don't match";
    if (mode === "recover" && !recoveryInput.trim()) return "Enter your recovery key";
    return null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = validate();
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      if (mode === "setup") {
        const rk = await vaultCreate(password);
        useVaultStore.getState().setUnlocked(true);
        setPassword(""); setConfirm("");
        setRecoveryKey(rk);
      } else {
        await vaultUnlockWithRecovery(recoveryInput.trim(), password);
        toast.info("Password changed. Your vault is unlocked.");
        await succeed();
      }
    } catch (err) {
      setError(vaultErrorMessage(err));
      setBusy(false);
    }
  };

  const copyKey = async () => {
    if (!recoveryKey) return;
    // copySecretTimed keeps it out of clipboard history and clears it after the user's setting; it shows its own
    // error toast on failure.
    const secs = await copySecretTimed(recoveryKey, "Recovery key", { quiet: true });
    if (secs !== null) {
      toast.info(secs > 0
        ? `Recovery key copied — it clears from the clipboard in ${clipboardClearLabel(secs)}. Paste it somewhere safe now.`
        : "Recovery key copied. Paste it somewhere safe now.");
    }
  };

  const label = "block text-xs mb-1 text-[var(--color-text-muted)]";

  // ── Step 2 of setup: show the recovery key exactly once ───────────────────
  if (recoveryKey) {
    return (
      <Dialog onClose={() => {}} dismissable={false} zClassName="z-[70]" size="sm" title="Save your recovery key" icon="shield">
        <DialogBody
          message={<>If you forget your master password, this key is the <b>only</b> way to open your locked notes.</>}
          detail="It is shown once and is not stored anywhere. Keep it somewhere safe and offline."
        >
          <div
            className="font-mono text-sm tracking-wide text-center select-all break-all rounded-md p-3 mb-3 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]"
            data-testid="recovery-key"
          >
            {recoveryKey}
          </div>
          <div className="flex justify-end gap-2 mb-3">
            <Button size="sm" icon={<Printer size={12} />} onClick={() => setShowKit(true)}>Print recovery kit</Button>
            <Button size="sm" icon={<Copy size={12} />} onClick={copyKey}>Copy</Button>
          </div>
          {showKit && <RecoveryKitDialog recoveryKey={recoveryKey} onClose={() => setShowKit(false)} />}
          <DialogCheckbox checked={saved} onChange={setSaved} label="I have saved my recovery key" />
        </DialogBody>
        <DialogFooter>
          <DialogButton
            variant="primary"
            disabled={!saved}
            onClick={async () => {
              setShowKit(false);
              setRecoveryKey(null);
              const sync = await useSyncStore.getState().refresh();
              const syncFlowContinues = isCreatingForSync(); // read before succeed() hands control back to the flow
              await succeed();
              if (!syncFlowContinues && shouldOfferSyncOnboarding(sync)) onCreated?.();
            }}
          >
            Done
          </DialogButton>
        </DialogFooter>
      </Dialog>
    );
  }

  const title = mode === "setup" ? "Set up Secure Vault" : "Reset with recovery key";

  // After a restore the vault exists and is locked: switch this dialog to the unlock step.
  if (restoring) {
    return (
      <RestoreBackupDialog
        onClose={() => {
          setRestoring(false);
          if (useVaultStore.getState().exists) useVaultStore.getState().setDialog("unlock");
        }}
      />
    );
  }

  return (
    <Dialog onClose={cancel} zClassName="z-[70]" size="sm" onSubmit={submit} title={title}
            icon={mode === "recover" ? <KeyRound size={16} /> : <Lock size={16} />}>
      <DialogBody>
        {mode === "setup" && driveAvailable && <SetupChoice onUseDrive={openDriveFromSetup} />}
        <p className="dlg-detail dlg-detail--block mb-4">
          {mode === "setup" && "Choose a master password. It encrypts your locked notes on this device and is never stored or sent anywhere."}
          {mode === "recover" && "Enter the recovery key you saved at setup, then choose a new master password."}
        </p>

        {mode === "recover" && (
          <div className="mb-3">
            <label className={label} htmlFor="vault-recovery">Recovery key</label>
            <Input
              id="vault-recovery" autoFocus spellCheck={false} autoComplete="off"
              className="font-mono"
              value={recoveryInput} onChange={(e) => setRecoveryInput(e.target.value)}
            />
          </div>
        )}

        <div className="mb-3">
          <label className={label} htmlFor="vault-password">
            {mode === "recover" ? "New master password" : "Master password"}
          </label>
          <PasswordInput
            id="vault-password" autoFocus={mode !== "recover"} autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
          <PasswordStrengthMeter password={password} />
        </div>

        <div className="mb-3">
          <label className={label} htmlFor="vault-confirm">Confirm password</label>
          <PasswordInput
            id="vault-confirm" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        {error && <p role="alert" className="text-xs mb-3 text-[var(--color-danger)]">{error}</p>}
      </DialogBody>
      <DialogFooter
        start={mode === "setup" ? (
          <button type="button" className="dlg-link" onClick={() => setRestoring(true)}>
            Restore from backup file
          </button>
        ) : undefined}
      >
        <DialogButton cancel onClick={cancel}>Cancel</DialogButton>
        <DialogButton type="submit" variant="primary" loading={busy}
                      loadingText={mode === "setup" ? "Creating…" : "Resetting…"}>
          {mode === "setup" ? "Create vault" : "Reset & unlock"}
        </DialogButton>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * "Use my vault from Google Drive" on the setup screen: hand over to the one sync setup flow. Whoever waited for
 * the vault (e.g. opening a locked note) continues when that flow ends.
 */
function openDriveFromSetup() {
  useVaultStore.getState().setDialog(null);
  void startSyncSetup({ fromSetup: true });
}

/**
 * Top of the setup screen: "Create a new vault" (this form) next to "Use my vault from Google Drive" as an
 * equal-weight choice card, so someone setting up a second PC doesn't create a separate vault by mistake.
 */
export function SetupChoice({ onUseDrive }: { onUseDrive: () => void }) {
  const card = "flex-1 min-w-0 flex flex-col items-start gap-1 rounded-md p-2.5 text-left border";
  return (
    <div className="flex gap-2 mb-4" role="group" aria-label="How to set up the vault">
      <div className={`${card} border-[var(--color-primary)] bg-[var(--color-bg-tertiary)]`} aria-current="step">
        <ShieldPlus size={15} className="text-[var(--color-primary)]" aria-hidden />
        <span className="text-[12.5px] font-semibold text-[var(--color-text)]">Create a new vault</span>
        <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">Start fresh on this PC.</span>
      </div>
      <button
        type="button" onClick={onUseDrive} data-testid="setup-use-drive"
        className={`${card} cursor-pointer border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]`}
      >
        <Cloud size={15} className="text-[var(--color-text-muted)]" aria-hidden />
        <span className="text-[12.5px] font-semibold text-[var(--color-text)]">Use my vault from Google Drive</span>
        <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">Already syncing on another PC.</span>
      </button>
    </div>
  );
}
