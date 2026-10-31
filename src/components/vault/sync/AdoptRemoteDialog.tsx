import { useState } from "react";
import { CloudDownload } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../../ui/Dialog";
import { PasswordInput } from "../../ui/PasswordInput";
import { useAppStore } from "../../../store";
import { useVaultStore } from "../../../store/vaultStore";
import { VAULT_CHANGED_EVENT } from "../../../lib/vault";
import {
  DEFAULT_ADOPT_CHOICE, HELLO_RESET_NOTE, adoptNeedsLocalPassword, describeAdoptResult, runAdopt,
  type AdoptChoice,
} from "../../../lib/vaultSyncFlows";
import type { AdoptResult } from "../../../lib/vaultSync";

export const ADOPT_CHOICES: { value: AdoptChoice; title: string; detail: string }[] = [
  {
    value: "import",
    title: "Import this PC's vault into the synced vault",
    detail: "A backup of this PC's vault is saved first. Identical logins are skipped; entries that differ are kept as \"Name (This PC)\".",
  },
  {
    value: "backupOnly",
    title: "Back up this PC's vault to a file, then use the synced vault",
    detail: "This PC's entries stay only in the backup file. You can restore or import it later.",
  },
  {
    value: "cancel",
    title: "Cancel",
    detail: "Keep this PC's vault as it is and don't turn on sync.",
  },
];

/** The three options (A is the default). Presentational, so it can be rendered on its own. */
export function AdoptChoiceList({ choice, onChange, disabled }: {
  choice: AdoptChoice; onChange: (c: AdoptChoice) => void; disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2 mb-4" disabled={disabled}>
      <legend className="sr-only">What to do with this PC's vault</legend>
      {ADOPT_CHOICES.map((c, i) => (
        <label
          key={c.value}
          className={`flex gap-2.5 items-start p-2.5 rounded-md border cursor-pointer ${choice === c.value
            ? "border-[var(--color-primary)] bg-[var(--color-bg-tertiary)]" : "border-[var(--color-border)]"}`}
        >
          <input
            type="radio" name="adopt-choice" value={c.value} className="mt-0.5 accent-[var(--color-primary)]"
            checked={choice === c.value} onChange={() => onChange(c.value)}
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{String.fromCharCode(65 + i)}. {c.title}</span>
            <span className="text-xs text-[var(--color-text-muted)]">{c.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * "Your Google Drive already holds a different vault": shown when turning on sync finds another vault in
 * Drive. A imports this PC's entries into it, B only backs this PC's vault up, C cancels.
 */
export function AdoptRemoteDialog({ onClose }: { onClose: (done: boolean) => void }) {
  const localUnlocked = useVaultStore((s) => s.unlocked);
  const [choice, setChoice] = useState<AdoptChoice>(DEFAULT_ADOPT_CHOICE);
  const [remotePw, setRemotePw] = useState("");
  const [localPw, setLocalPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: "remote" | "local"; text: string } | null>(null);
  const [done, setDone] = useState<{ result: AdoptResult; mode: "import" | "backupOnly" } | null>(null);

  const needLocal = adoptNeedsLocalPassword(choice, localUnlocked);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (choice === "cancel") { onClose(false); return; }
    setBusy(true);
    setError(null);
    const out = await runAdopt({ choice, remotePassword: remotePw, localPassword: localPw, localUnlocked });
    if (out.kind === "done") {
      setRemotePw(""); setLocalPw("");
      // This PC now uses the synced vault: refresh what's on screen.
      await useVaultStore.getState().refresh();
      window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
      if (useVaultStore.getState().unlocked) await useAppStore.getState().unlockVaultTabs();
      setDone({ result: out.result, mode: out.mode });
    } else if (out.kind === "invalid") {
      setError({ field: out.field, text: out.error });
    } else if (out.kind === "error") {
      setError({ text: out.error });
    }
    setBusy(false);
  };

  if (done) {
    return (
      <Dialog onClose={() => onClose(true)} zClassName="z-[80]" size="md" title="Sync is on" icon="success">
        <DialogBody message="This PC now uses the vault from your Google Drive.">
          <ul className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)] list-disc pl-4 mb-3 break-all">
            {describeAdoptResult(done.result, done.mode).map((l) => <li key={l}>{l}</li>)}
          </ul>
          <p className="text-xs p-2.5 rounded-md bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
            {HELLO_RESET_NOTE}
          </p>
        </DialogBody>
        <DialogFooter>
          <DialogButton variant="primary" onClick={() => onClose(true)}>Done</DialogButton>
        </DialogFooter>
      </Dialog>
    );
  }

  const label = "block text-xs mb-1 text-[var(--color-text-muted)]";
  return (
    <Dialog onClose={() => onClose(false)} zClassName="z-[80]" size="lg" onSubmit={submit} dismissable={!busy}
            title="Your Google Drive already has a vault" icon={<CloudDownload size={16} />}>
      <DialogBody
        message="The vault in your Google Drive is a different vault from the one on this PC."
        detail="A PC can sync only one vault. Choose what to do with this PC's vault."
      >
        <AdoptChoiceList choice={choice} onChange={(c) => { setChoice(c); setError(null); }} disabled={busy} />

        {choice !== "cancel" && (
          <div className="flex flex-col gap-3">
            <div>
              <label className={label} htmlFor="adopt-remote-pw">Master password of the vault in your Google Drive</label>
              <PasswordInput
                id="adopt-remote-pw" autoFocus autoComplete="current-password" disabled={busy}
                value={remotePw} onChange={(e) => { setRemotePw(e.target.value); setError(null); }}
                aria-invalid={error?.field === "remote"}
              />
            </div>
            {needLocal && (
              <div>
                <label className={label} htmlFor="adopt-local-pw">This PC's master password (its vault is locked)</label>
                <PasswordInput
                  id="adopt-local-pw" autoComplete="current-password" disabled={busy}
                  value={localPw} onChange={(e) => { setLocalPw(e.target.value); setError(null); }}
                  aria-invalid={error?.field === "local"}
                />
              </div>
            )}
          </div>
        )}

        {error && <p role="alert" className="text-xs mt-3 text-[var(--color-danger)]">{error.text}</p>}
      </DialogBody>
      <DialogFooter>
        {choice !== "cancel" && <DialogButton cancel onClick={() => onClose(false)} disabled={busy}>Cancel</DialogButton>}
        <DialogButton type="submit" variant="primary" disabled={busy}>
          {busy ? "Working…" : choice === "import" ? "Back up and import" : choice === "backupOnly" ? "Back up and switch" : "Close"}
        </DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
