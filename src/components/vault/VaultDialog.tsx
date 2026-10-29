import { useEffect, useState } from "react";
import { KeyRound, Lock, Copy, Printer, Fingerprint } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogCheckbox, DialogFooter } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { PasswordInput } from "../ui/PasswordInput";
import { Button } from "../ui/Button";
import { RestoreBackupDialog } from "./RestoreBackupDialog";
import { RecoveryKitDialog } from "./RecoveryKitDialog"; // 0.7.0 recovery kit
import { toast } from "../../lib/toast";
import { initVaultStateSync, useVaultStore, type VaultDialogMode } from "../../store/vaultStore";
import { useAppStore } from "../../store";
import { useVaultAutoLock } from "../../hooks/useVaultAutoLock";
import { useVaultSessionLock } from "../../hooks/useVaultSessionLock";
import { copySecret } from "../../lib/secureCopy";
import {
  vaultCreate, vaultUnlock, vaultUnlockWithRecovery, vaultErrorMessage,
} from "../../lib/vault";
import { helloStatus, helloUnlock, isHelloCancel } from "../../lib/hello"; // 0.7.0 hello
import { getUnlockMethod, setUnlockMethod, type UnlockMethod } from "../../lib/unlockMethod";

const MIN_LEN = 8;

/** Mounted once (AppOverlays). Renders the setup / unlock / recover dialog. */
export function VaultDialog() {
  const mode = useVaultStore((s) => s.dialog);
  useEffect(() => { void useVaultStore.getState().refresh(); }, []);
  // Follow an unlock done in the autofill prompt window (and its saved logins).
  useEffect(() => initVaultStateSync("main"), []);
  // This component is mounted once for the whole app, so it also hosts the
  // vault's global behaviour (idle / close-to-tray auto-lock).
  useVaultAutoLock();
  useVaultSessionLock();
  // key={mode} remounts on mode switch so passwords never leak between steps.
  return (
    mode ? <VaultDialogInner key={mode} mode={mode} /> : null
  );
}

function VaultDialogInner({ mode }: { mode: VaultDialogMode }) {
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

  const cancel = () => useVaultStore.getState().finish(false);

  const succeed = async () => {
    useVaultStore.getState().setUnlocked(true);
    await useAppStore.getState().unlockVaultTabs();
    useVaultStore.getState().finish(true);
  };

  // 0.7.0 hello: offered on the unlock step only when turned on; never auto-triggered. The dialog opens
  // with the method the user unlocked with last time and lets them switch.
  const [helloOn, setHelloOn] = useState(false);
  const [method, setMethod] = useState<UnlockMethod>(getUnlockMethod);
  const showHello = mode === "unlock" && helloOn && method === "hello";
  useEffect(() => {
    if (mode !== "unlock") return;
    let live = true;
    void helloStatus().then((s) => { if (live) setHelloOn(s.enabled); });
    return () => { live = false; };
  }, [mode]);
  const unlockWithHello = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await helloUnlock();
      setUnlockMethod("hello");
      await succeed();
    } catch (err) {
      const msg = vaultErrorMessage(err);
      setError(isHelloCancel(msg) ? null : msg);
      setHelloOn((await helloStatus()).enabled);
      setBusy(false);
    }
  };

  const needsNewPassword = mode === "setup" || mode === "recover";

  const validate = (): string | null => {
    if (needsNewPassword) {
      if (password.length < MIN_LEN) return `Password must be at least ${MIN_LEN} characters`;
      if (password !== confirm) return "Passwords don't match";
    } else if (!password) {
      return "Enter your master password";
    }
    if (mode === "recover" && !recoveryInput.trim()) return "Enter your recovery key";
    return null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (showHello) { void unlockWithHello(); return; } // Enter in the Hello view
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
      } else if (mode === "unlock") {
        await vaultUnlock(password);
        if (helloOn) setUnlockMethod("password");
        await succeed();
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
    // copySecret keeps it out of clipboard history and clears it after 20 s; it shows its own error toast on failure.
    if (await copySecret(recoveryKey, "Recovery key", { quiet: true })) {
      toast.info("Recovery key copied — it clears from the clipboard in 20 s. Paste it somewhere safe now.");
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
              await succeed();
            }}
          >
            Done
          </DialogButton>
        </DialogFooter>
      </Dialog>
    );
  }

  const title =
    mode === "setup" ? "Set up Secure Vault" :
    mode === "unlock" ? "Unlock vault" : "Reset with recovery key";

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
        <p className="dlg-detail dlg-detail--block mb-4">
          {mode === "setup" && "Choose a master password. It encrypts your locked notes on this device and is never stored or sent anywhere."}
          {mode === "unlock" && "Enter your master password to open locked notes."}
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

        {showHello ? (
          <div className="flex flex-col items-center gap-3 pt-1 pb-2">
            <span className="grid place-items-center w-14 h-14 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-primary)]">
              <Fingerprint size={28} strokeWidth={1.6} />
            </span>
            <Button type="button" variant="primary" className="w-full justify-center" autoFocus disabled={busy}
                    icon={<Fingerprint size={15} />} onClick={() => void unlockWithHello()}>
              {busy ? "Waiting for Windows Hello…" : "Unlock with Windows Hello"}
            </Button>
            <button type="button" className="dlg-link" disabled={busy}
                    onClick={() => { setError(null); setMethod("password"); }}>
              Use master password instead
            </button>
          </div>
        ) : (
        <div className="mb-3">
          <label className={label} htmlFor="vault-password">
            {mode === "recover" ? "New master password" : "Master password"}
          </label>
          <PasswordInput
            id="vault-password" autoFocus={mode !== "recover"}
            autoComplete={needsNewPassword ? "new-password" : "current-password"}
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        )}

        {needsNewPassword && (
          <div className="mb-3">
            <label className={label} htmlFor="vault-confirm">Confirm password</label>
            <PasswordInput
              id="vault-confirm" autoComplete="new-password"
              value={confirm} onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        )}

        {error && <p role="alert" className="text-xs mb-3 text-[var(--color-danger)]">{error}</p>}

        {mode === "unlock" && helloOn && method === "password" && (
          <button type="button" className="dlg-link inline-flex items-center gap-1.5" disabled={busy}
                  onClick={() => { setError(null); setMethod("hello"); }}>
            <Fingerprint size={14} /> Use Windows Hello instead
          </button>
        )}

      </DialogBody>
      <DialogFooter
        start={mode === "unlock" ? (
          <button
            type="button"
            className="dlg-link"
            onClick={() => useVaultStore.getState().setDialog("recover")}
          >
            Forgot password?
          </button>
        ) : mode === "setup" ? (
          <button
            type="button"
            className="dlg-link"
            onClick={() => setRestoring(true)}
          >
            Restore from backup file
          </button>
        ) : undefined}
      >
        <DialogButton cancel onClick={cancel}>Cancel</DialogButton>
        {!showHello && (
        <DialogButton type="submit" variant="primary" disabled={busy}>
          {busy ? "Working…" : mode === "setup" ? "Create vault" : mode === "unlock" ? "Unlock" : "Reset & unlock"}
        </DialogButton>
        )}
      </DialogFooter>
    </Dialog>
  );
}
