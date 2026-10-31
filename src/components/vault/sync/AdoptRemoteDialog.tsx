import { useEffect, useState } from "react";
import { CloudDownload } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../../ui/Dialog";
import { PasswordInput } from "../../ui/PasswordInput";
import { useVaultStore } from "../../../store/vaultStore";
import { toast } from "../../../lib/toast";
import { vaultList } from "../../../lib/vault";
import { syncDevices } from "../../../lib/vaultSync";
import { HELLO_RESET_NOTE, adoptNeedsLocalPassword, runAdopt } from "../../../lib/vaultSyncFlows";
import { countEntries } from "../../../lib/syncLifecycle";
import { BACKUP_BEFORE_TEXT, itemsText, lastChangedText, twoVaultsDoneMessage } from "../../../lib/syncSetup";
import { refreshVaultUi } from "../../../lib/syncSetupFlow";

export type TwoVaultsChoice = "import" | "backupOnly";

export const ADOPT_CHOICES: { value: TwoVaultsChoice; title: string; detail: string; recommended?: boolean }[] = [
  {
    value: "import",
    title: "Use the Google Drive vault and add this PC's items to it",
    detail: "This PC's items are copied in. Identical logins are skipped; others are kept as \"Name (This PC)\".",
    recommended: true,
  },
  {
    value: "backupOnly",
    title: "Use the Google Drive vault only",
    detail: "This PC's vault is saved as a backup file you can import later.",
  },
];

/** The two choices (the first is recommended and selected by default). */
export function AdoptChoiceList({ choice, onChange, disabled }: {
  choice: TwoVaultsChoice; onChange: (c: TwoVaultsChoice) => void; disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2 mb-4" disabled={disabled}>
      <legend className="sr-only">Which vault this PC keeps using</legend>
      {ADOPT_CHOICES.map((c) => (
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
            <span className="text-sm font-medium">
              {c.title}
              {c.recommended && <span className="ml-1.5 text-[11px] font-normal text-[var(--color-primary)]">Recommended</span>}
            </span>
            <span className="text-xs text-[var(--color-text-muted)]">{c.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export interface TwoVaultsDialogProps {
  /** Entries in this PC's vault (null when unknown). */
  items: number | null;
  /** "last changed on LAPTOP, 2 hours ago" for the Drive vault (null when unknown). */
  lastChanged: string | null;
  busy: boolean;
  error: string | null;
  /** This PC's vault is locked: importing also needs its password. */
  localLocked?: boolean;
  onContinue: (choice: TwoVaultsChoice, remotePassword: string, localPassword: string) => void;
  /** "Keep this PC separate" (= cancel; sync stays off). */
  onKeepSeparate: () => void;
  onEdit?: () => void;
}

/** F5 "This PC and Google Drive have different vaults" (replaces the old A/B/C dialog). */
export function TwoVaultsDialog({ items, lastChanged, busy, error, localLocked, onContinue, onKeepSeparate, onEdit }: TwoVaultsDialogProps) {
  const [choice, setChoice] = useState<TwoVaultsChoice>("import");
  const [remotePw, setRemotePw] = useState("");
  const [localPw, setLocalPw] = useState("");
  const needLocal = adoptNeedsLocalPassword(choice, !localLocked);
  const label = "block text-xs mb-1 text-[var(--color-text-muted)]";
  const facts = [
    items != null ? `This PC: ${itemsText(items)}` : null,
    lastChanged ? `Google Drive: ${lastChanged}` : null,
  ].filter(Boolean);

  return (
    <Dialog onClose={onKeepSeparate} zClassName="z-[80]" size="lg" dismissable={!busy}
            onSubmit={(e) => { e.preventDefault(); if (!busy) onContinue(choice, remotePw, localPw); }}
            title="This PC and Google Drive have different vaults" icon={<CloudDownload size={16} />}>
      <DialogBody>
        {facts.length > 0 && <p className="text-xs mb-2 text-[var(--color-text-muted)]" data-testid="two-vaults-facts">{facts.join(" · ")}</p>}
        <p className="dlg-detail dlg-detail--block mb-3">A PC syncs one vault. Choose which one to keep using:</p>
        <AdoptChoiceList choice={choice} onChange={(c) => { setChoice(c); onEdit?.(); }} disabled={busy} />
        <div className="flex flex-col gap-3">
          <div>
            <label className={label} htmlFor="adopt-remote-pw">Master password of the Google Drive vault</label>
            <PasswordInput
              id="adopt-remote-pw" autoFocus autoComplete="current-password" disabled={busy}
              value={remotePw} onChange={(e) => { setRemotePw(e.target.value); onEdit?.(); }}
              aria-invalid={!!error} aria-describedby={error ? "adopt-error" : undefined}
            />
          </div>
          {needLocal && (
            <div>
              <label className={label} htmlFor="adopt-local-pw">This PC's master password (its vault is locked)</label>
              <PasswordInput
                id="adopt-local-pw" autoComplete="current-password" disabled={busy}
                value={localPw} onChange={(e) => { setLocalPw(e.target.value); onEdit?.(); }}
              />
            </div>
          )}
          <p className="text-xs text-[var(--color-text-muted)]">{BACKUP_BEFORE_TEXT}</p>
        </div>
        {error && <p id="adopt-error" role="alert" className="text-xs mt-3 text-[var(--color-danger)]">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <DialogButton onClick={onKeepSeparate} disabled={busy}>Keep this PC separate</DialogButton>
        <DialogButton type="submit" variant="primary" disabled={busy}>{busy ? "Working…" : "Continue"}</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Stand-alone host of the two-vaults dialog for callers outside the setup flow (the sync popover's
 * "Turn on sync"): loads the counts, runs the choice, refreshes everything and shows the result toast.
 */
export function AdoptRemoteDialog({ onClose }: { onClose: (done: boolean) => void }) {
  const localUnlocked = useVaultStore((s) => s.unlocked);
  const [items, setItems] = useState<number | null>(null);
  const [lastChanged, setLastChanged] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (localUnlocked) vaultList().then((l) => { if (live) setItems(countEntries(l)); }).catch(() => {});
    syncDevices().then((d) => { if (live) setLastChanged(lastChangedText(d)); }).catch(() => {});
    return () => { live = false; };
  }, [localUnlocked]);

  const onContinue = async (choice: TwoVaultsChoice, remotePassword: string, localPassword: string) => {
    setBusy(true);
    setError(null);
    const out = await runAdopt({ choice, remotePassword, localPassword, localUnlocked });
    if (out.kind === "done") {
      await refreshVaultUi();
      const detail = [`A backup of this PC's vault was saved to ${out.result.backupPath}`, HELLO_RESET_NOTE].join("\n");
      toast.success(twoVaultsDoneMessage(out.mode, out.result.imported), { source: "Vault sync", detail });
      onClose(true);
      return;
    }
    setBusy(false);
    if (out.kind === "invalid" || out.kind === "error") setError(out.error);
  };

  return (
    <TwoVaultsDialog
      items={items} lastChanged={lastChanged} busy={busy} error={error} localLocked={!localUnlocked}
      onContinue={(c, r, l) => void onContinue(c, r, l)}
      onKeepSeparate={() => onClose(false)}
      onEdit={() => setError(null)}
    />
  );
}
