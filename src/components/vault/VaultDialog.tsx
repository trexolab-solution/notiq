import { useEffect, useState } from "react";
import { KeyRound, Lock, Copy, ShieldCheck } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Input } from "../ui/Input";
import { PasswordInput } from "../ui/PasswordInput";
import { Button } from "../ui/Button";
import { toast } from "../../lib/toast";
import { useVaultStore, type VaultDialogMode } from "../../store/vaultStore";
import { useAppStore } from "../../store";
import { useVaultAutoLock } from "../../hooks/useVaultAutoLock";
import { useTelegramAutoSync } from "../../hooks/useTelegramAutoSync";
import {
  vaultCreate, vaultUnlock, vaultUnlockWithRecovery, vaultErrorMessage,
} from "../../lib/vault";
import { errText, tgBootstrap, tgDetectChat } from "../../lib/telegram";

const MIN_LEN = 8;

/** Mounted once (AppOverlays). Renders the setup / unlock / recover dialog. */
export function VaultDialog() {
  const mode = useVaultStore((s) => s.dialog);
  useEffect(() => { void useVaultStore.getState().refresh(); }, []);
  // This component is mounted once for the whole app, so it also hosts the
  // vault's global behaviour (idle / close-to-tray auto-lock).
  useVaultAutoLock();
  useTelegramAutoSync();
  if (!mode) return null;
  // key={mode} remounts on mode switch so passwords never leak between steps.
  return <VaultDialogInner key={mode} mode={mode} />;
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
  // New device: fetch the key file from the user's Telegram backup instead of creating a vault.
  const [restoring, setRestoring] = useState(false);
  const [tgToken, setTgToken] = useState("");

  const cancel = () => useVaultStore.getState().finish(false);

  const succeed = async () => {
    useVaultStore.getState().setUnlocked(true);
    await useAppStore.getState().unlockVaultTabs();
    useVaultStore.getState().finish(true);
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
    try {
      await navigator.clipboard.writeText(recoveryKey);
      toast.info("Recovery key copied. Paste it somewhere safe, then clear your clipboard.");
    } catch {
      toast.error("Couldn't copy — please write the key down by hand");
    }
  };

  const panel = "w-[400px] max-w-[92vw] rounded-xl p-5 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl text-[var(--color-text)]";
  const label = "block text-xs mb-1 text-[var(--color-text-muted)]";

  // ── Step 2 of setup: show the recovery key exactly once ───────────────────
  if (recoveryKey) {
    return (
      <Modal onClose={() => {}} dismissable={false} zClassName="z-[70]">
        <div className={panel} role="dialog" aria-modal="true" aria-label="Save your recovery key">
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck size={18} style={{ color: "var(--color-primary)" }} />
            <h2 className="text-sm font-semibold">Save your recovery key</h2>
          </div>
          <p className="text-xs mb-3 text-[var(--color-text-muted)]">
            If you forget your master password, this key is the <b>only</b> way to open your locked notes.
            It is shown once and is not stored anywhere. Keep it somewhere safe and offline.
          </p>
          <div
            className="font-mono text-sm tracking-wide text-center select-all break-all rounded-md p-3 mb-3 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]"
            data-testid="recovery-key"
          >
            {recoveryKey}
          </div>
          <div className="flex justify-end mb-3">
            <Button size="sm" icon={<Copy size={12} />} onClick={copyKey}>Copy</Button>
          </div>
          <label className="flex items-center gap-2 text-xs mb-4 cursor-pointer select-none">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I have saved my recovery key
          </label>
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!saved}
              onClick={async () => { setRecoveryKey(null); await succeed(); }}
            >
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  const restoreFromTelegram = async () => {
    if (busy) return;
    const token = tgToken.trim();
    if (!token) { setError("Enter your bot token"); return; }
    setBusy(true); setError(null);
    try {
      const chatId = await tgDetectChat(token);
      await tgBootstrap(token, chatId);
      setTgToken("");
      await useVaultStore.getState().refresh();
      toast.info("Vault found. Enter your master password — your notes will sync after you unlock.");
      useVaultStore.getState().setDialog("unlock");
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  if (mode === "setup" && restoring) {
    return (
      <Modal onClose={cancel} zClassName="z-[70]">
        <form className={panel} onSubmit={(e) => { e.preventDefault(); void restoreFromTelegram(); }}
              role="dialog" aria-modal="true" aria-label="Restore vault from Telegram">
          <div className="flex items-center gap-2 mb-1">
            <Lock size={18} style={{ color: "var(--color-primary)" }} />
            <h2 className="text-sm font-semibold">Restore vault from Telegram</h2>
          </div>
          <p className="text-xs mb-4 text-[var(--color-text-muted)]">
            Paste the bot token you used on your other device. Notiq downloads your encrypted key file;
            then unlock with your master password and your notes sync down.
          </p>
          <label className={label} htmlFor="vault-tg-token">Bot token</label>
          <PasswordInput id="vault-tg-token" autoFocus autoComplete="off" spellCheck={false}
                         value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
          {error && <p role="alert" className="text-xs mt-3 text-[var(--color-danger)]">{error}</p>}
          <div className="flex items-center justify-between mt-4">
            <button type="button" className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline cursor-pointer"
                    onClick={() => { setRestoring(false); setError(null); }}>
              Back
            </button>
            <div className="flex gap-2">
              <Button type="button" onClick={cancel}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={busy}>{busy ? "Working…" : "Restore"}</Button>
            </div>
          </div>
        </form>
      </Modal>
    );
  }

  const title =
    mode === "setup" ? "Set up Secure Vault" :
    mode === "unlock" ? "Unlock vault" : "Reset with recovery key";

  return (
    <Modal onClose={cancel} zClassName="z-[70]">
      <form className={panel} onSubmit={submit} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-center gap-2 mb-1">
          {mode === "recover" ? <KeyRound size={18} /> : <Lock size={18} style={{ color: "var(--color-primary)" }} />}
          <h2 className="text-sm font-semibold">{title}</h2>
        </div>
        <p className="text-xs mb-4 text-[var(--color-text-muted)]">
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

        <div className="flex items-center justify-between mt-4">
          {mode === "unlock" ? (
            <button
              type="button"
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline cursor-pointer"
              onClick={() => useVaultStore.getState().setDialog("recover")}
            >
              Forgot password?
            </button>
          ) : mode === "setup" ? (
            <button
              type="button"
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline cursor-pointer"
              onClick={() => { setRestoring(true); setError(null); }}
            >
              Restore from Telegram
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <Button type="button" onClick={cancel}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Working…" : mode === "setup" ? "Create vault" : mode === "unlock" ? "Unlock" : "Reset & unlock"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
