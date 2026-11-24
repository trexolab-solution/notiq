import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, Download, FileUp, PackageOpen, Share2, ShieldCheck } from "lucide-react";
import { Modal } from "../ui/Modal";
import { PasswordInput } from "../ui/PasswordInput";
import { Button } from "../ui/Button";
import { SettingRow } from "../ui/SettingRow";
import { RestoreBackupDialog } from "./RestoreBackupDialog";
import { ImportSharedDialog } from "./ImportSharedDialog";
import { ShareItemsDialog } from "./ShareItemsDialog";
import { ChooseKindDialog } from "./ChooseKindDialog";
import { toast } from "../../lib/toast";
import { useVaultStore } from "../../store/vaultStore";
import { vaultErrorMessage } from "../../lib/vault";
import { checkDroppedBackup, exportBackupWithDialog, vaultBackupInspect, vaultVerifyPassword, formatBytes } from "../../lib/vaultBackup";
import {
  BACKUP_EVENT, describeAge, getLastBackup, noteVaultSeen,
  getBackupReminderDisabled, setBackupReminderDisabled,
} from "../../lib/backupReminder";
import { Toggle } from "../ui/Toggle";

/** Settings -> Vault -> "Backup": renders the rows of that group (put it inside a SettingsGroup). */
export function BackupSection() {
  const exists = useVaultStore((s) => s.exists);
  const [last, setLast] = useState<number | null>(() => getLastBackup());
  const [remind, setRemind] = useState(() => !getBackupReminderDisabled());
  const [askPw, setAskPw] = useState(false);
  /** Which dialog is open: the choice for Export / Import, or one of the flows. */
  const [dialog, setDialog] = useState<"export" | "import" | "restore" | "importShare" | "share" | null>(null);
  /** A file the Import choice was given by drag and drop: the flow it picked opens with it. */
  const [droppedPath, setDroppedPath] = useState<string | undefined>(undefined);
  const close = () => { setDialog(null); setDroppedPath(undefined); };
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sync = () => { setLast(getLastBackup()); setRemind(!getBackupReminderDisabled()); };
    window.addEventListener(BACKUP_EVENT, sync);
    return () => window.removeEventListener(BACKUP_EVENT, sync);
  }, []);
  useEffect(() => { if (exists) noteVaultSeen(); }, [exists]);

  const runExport = async () => {
    setBusy(true);
    try {
      const res = await exportBackupWithDialog();
      if (res) toast.info(`Backup saved (${formatBytes(res.bytes)}). Keep it somewhere safe.`);
    } catch (e) {
      toast.error("Backup failed", { source: "Backup", detail: vaultErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const startShare = async () => {
    setDialog(null);
    if (!useVaultStore.getState().unlocked && !(await useVaultStore.getState().ensureUnlocked())) return;
    setDialog("share");
  };

  /** A file dropped on the Import choice: a share file opens the share import, anything else the restore. */
  const routeDrop = async (paths: string[]) => {
    const r = await checkDroppedBackup(paths);
    if ("error" in r) { toast.error(r.error); return; }
    try {
      const h = await vaultBackupInspect(r.path);
      setDroppedPath(r.path);
      setDialog(h.kind === "share" ? "importShare" : "restore");
    } catch (e) { toast.error(vaultErrorMessage(e)); }
  };

  const start = async () => {
    if (busy) return;
    const { unlocked } = useVaultStore.getState();
    if (!unlocked) {
      // Unlocking with the master password is itself the password check.
      if (!(await useVaultStore.getState().ensureUnlocked())) return;
      await runExport();
    } else {
      setAskPw(true);
    }
  };

  return (
    <>
      <SettingRow
        id="vault.backup.export"
        label="Export"
        description={`${last ? `Last backup: ${describeAge(last, Date.now())} (${new Date(last).toLocaleString()}).` : "You haven't exported a backup yet."} Save an encrypted backup of your whole vault, or share chosen items with someone else.`}
        help="Without the backup file plus the master password or recovery key, a backup cannot be opened, so keep it somewhere safe."
        keywords={["backup", "last backup", "export", "save a copy", ".nqb", "encrypted", "share", "send", "give", "someone", "expire", "temporary"]}
      >
        <Button className="settings-btn-primary" size="sm" variant="primary" icon={<Download size={12} />} disabled={!exists} loading={busy} loadingText="Exporting…" onClick={() => setDialog("export")}>
          Export…
        </Button>
      </SettingRow>

      <SettingRow
        id="vault.backup.import"
        label="Import"
        description="Restore a .nqb backup (merge it into this vault or replace it), or import items someone shared with you. Drop a file on the dialog and Notiq picks the right one."
        keywords={["restore", "backup", "import", ".nqb", "recover", "merge", "share", "shared", "receive", "password"]}
      >
        <Button className="settings-btn" size="sm" icon={<FileUp size={12} />} onClick={() => setDialog("import")}>Import…</Button>
      </SettingRow>

      <SettingRow
        id="vault.backup.remind"
        label="Remind me to back up"
        description="A reminder appears if you never backed up (after 3 days) or the last backup is over 30 days old."
        keywords={["backup", "reminder", "notification", "nag"]}
        modified={!remind}
        onReset={() => { setRemind(true); setBackupReminderDisabled(false); }}
      >
        <Toggle value={remind} onChange={(v) => { setRemind(v); setBackupReminderDisabled(!v); }} aria-label="Remind me to back up" />
      </SettingRow>

      {askPw && (
        <PasswordPrompt
          onCancel={() => setAskPw(false)}
          onVerified={() => { setAskPw(false); void runExport(); }}
        />
      )}
      {dialog === "export" && (
        <ChooseKindDialog
          title="Export" icon={<Download size={16} />} initial="backup" onClose={close}
          intro="What do you want to export?"
          options={[
            { value: "backup", title: "Backup of my vault", icon: <Archive size={16} />, description: "Everything in it, encrypted with your master password. To keep safe, or to move to another PC." },
            { value: "share", title: "Share chosen items", icon: <Share2 size={16} />, description: "Only what you pick, with a password for the receiver. You set how often it can be imported, how long it works and how long the items stay." },
          ]}
          onChoose={(v) => { if (v === "backup") { setDialog(null); void start(); } else void startShare(); }}
        />
      )}
      {dialog === "import" && (
        <ChooseKindDialog
          title="Import" icon={<FileUp size={16} />} initial="restore" onClose={close}
          intro="What do you want to import?"
          options={[
            { value: "restore", title: "Restore a backup", icon: <ArchiveRestore size={16} />, description: "A backup of a whole vault: merge it into this vault, or replace it." },
            { value: "share", title: "Import shared items", icon: <PackageOpen size={16} />, description: "A share file someone made for you. You need the password they gave you, and your own vault open." },
          ]}
          dropHint="Or drop the file here: Notiq opens the right one."
          onDrop={(p) => void routeDrop(p)}
          onChoose={(v) => setDialog(v === "restore" ? "restore" : "importShare")}
        />
      )}
      {dialog === "restore" && <RestoreBackupDialog initialPath={droppedPath} onClose={close} />}
      {dialog === "importShare" && <ImportSharedDialog initialPath={droppedPath} onClose={close} />}
      {dialog === "share" && <ShareItemsDialog onClose={close} />}
    </>
  );
}

function PasswordPrompt({ onCancel, onVerified }: { onCancel: () => void; onVerified: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !pw) { if (!pw) setError("Enter your master password"); return; }
    setBusy(true); setError(null);
    try {
      await vaultVerifyPassword(pw);
      setPw("");
      onVerified();
    } catch (err) {
      setError(vaultErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onCancel} zClassName="z-[80]">
      <form
        onSubmit={submit}
        role="dialog" aria-modal="true" aria-label="Confirm master password"
        className="w-[380px] max-w-[92vw] rounded-xl p-5 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl text-[var(--color-text)]"
      >
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck size={18} style={{ color: "var(--color-primary)" }} />
          <h2 className="text-sm font-semibold">Confirm your master password</h2>
        </div>
        <p className="text-xs mb-3 text-[var(--color-text-muted)]">
          Needed to export a backup of your vault. The backup stays encrypted.
        </p>
        <PasswordInput autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        {error && <p role="alert" className="text-xs mt-2 text-[var(--color-danger)]">{error}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <Button className="settings-btn" type="button" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} loadingText="Checking…">Continue</Button>
        </div>
      </form>
    </Modal>
  );
}
