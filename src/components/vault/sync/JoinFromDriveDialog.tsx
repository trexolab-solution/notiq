import { useEffect, useState } from "react";
import { Cloud, Loader2 } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../../ui/Dialog";
import { PasswordInput } from "../../ui/PasswordInput";
import { Button } from "../../ui/Button";
import { useVaultStore } from "../../../store/vaultStore";
import { VAULT_CHANGED_EVENT } from "../../../lib/vault";
import { useSyncStore } from "../../../lib/vaultSync";
import { joinStep, runJoin, type JoinStep } from "../../../lib/vaultSyncFlows";
import { useSyncConnect } from "./useSyncConnect";
import { ConnectWaiting } from "./ConnectWaiting";

export const NO_REMOTE_TEXT =
  "There's no synced vault in this Google account yet. On the PC that has your vault, open Settings → Vault → Sync and turn on sync, then try again here.";

/**
 * Vault setup → "Use my vault from Google Drive": Google sign-in → check Drive → master password →
 * download. The vault ends up unlocked; `onJoined` finishes the setup dialog.
 */
export function JoinFromDriveDialog({ onBack, onJoined }: { onBack: () => void; onJoined: () => void | Promise<void> }) {
  const account = useSyncStore((s) => s.status?.account ?? null);
  const [step, setStep] = useState<JoinStep | "loading">("loading");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const advance = async () => {
    setStep("loading");
    const status = await useSyncStore.getState().refresh();
    const next = await joinStep(status);
    setStep(next.step);
    setError(next.error ?? null);
  };

  const { connecting, error: connectError, connect, cancel } = useSyncConnect(() => { void advance(); });

  useEffect(() => { void advance(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || step !== "password") return;
    setBusy(true);
    setError(null);
    const out = await runJoin(password);
    if (out.kind === "joined") {
      setPassword("");
      useVaultStore.getState().setUnlocked(true);
      window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
      await onJoined();
      return;
    }
    setBusy(false);
    if (out.kind === "noRemote") setStep("noRemote");
    else setError(out.error);
  };

  const label = "block text-xs mb-1 text-[var(--color-text-muted)]";
  const errText = error ?? connectError;

  return (
    <Dialog onClose={onBack} dismissable={!busy} zClassName="z-[70]" size="sm" onSubmit={submit}
            title="Use my vault from Google Drive" icon={<Cloud size={16} />}>
      <DialogBody>
        {step === "loading" && (
          <p className="dlg-detail dlg-detail--block inline-flex items-center gap-2" aria-live="polite">
            <Loader2 size={14} className="animate-spin" aria-hidden /> Checking…
          </p>
        )}

        {step === "notConfigured" && (
          <p className="dlg-detail dlg-detail--block">
            Sync with Google Drive isn't available in this build of Notiq. Create a new vault, or restore one from a backup file.
          </p>
        )}

        {step === "connect" && (
          <div className="flex flex-col gap-3">
            <p className="dlg-detail dlg-detail--block">
              Sign in with the Google account your other PC syncs to. Notiq can only see its own files in your Drive.
            </p>
            {connecting ? (
              <ConnectWaiting onCancel={cancel} />
            ) : (
              <div><Button variant="primary" onClick={() => void connect()}>Sign in with Google</Button></div>
            )}
          </div>
        )}

        {step === "noRemote" && (
          <div className="flex flex-col gap-2">
            {account && <p className="text-xs text-[var(--color-text-muted)]">Signed in as {account}</p>}
            <p className="dlg-detail dlg-detail--block">{NO_REMOTE_TEXT}</p>
          </div>
        )}

        {step === "password" && (
          <div className="flex flex-col gap-3">
            <p className="dlg-detail dlg-detail--block">
              Found your vault{account ? ` in ${account}` : ""}. Enter its master password to download and open it on this PC.
            </p>
            <div>
              <label className={label} htmlFor="join-password">Master password</label>
              <PasswordInput
                id="join-password" autoFocus autoComplete="current-password" disabled={busy}
                value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }}
                aria-invalid={!!error} aria-describedby={error ? "join-error" : undefined}
              />
            </div>
          </div>
        )}

        {errText && <p id="join-error" role="alert" className="text-xs mt-3 text-[var(--color-danger)]">{errText}</p>}
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onBack} disabled={busy}>Back</DialogButton>
        {step === "noRemote" && <DialogButton variant="primary" onClick={() => void advance()}>Try again</DialogButton>}
        {step === "password" && (
          <DialogButton type="submit" variant="primary" disabled={busy}>{busy ? "Downloading…" : "Open vault"}</DialogButton>
        )}
      </DialogFooter>
    </Dialog>
  );
}
