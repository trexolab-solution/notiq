import { useEffect, useState } from "react";
import { Cloud, FolderOpen, HardDrive, Lock, LockOpen, RotateCcw, ShieldCheck } from "lucide-react";
import { useVaultStore } from "../../store/vaultStore";
import { pickVaultDir, resetVaultDir } from "../../lib/vaultDir";
import { getVaultDir } from "../../lib/vaultPrefs";
import { useVaultItems } from "./sidebar/useVaultItems";
import { PanelHeader } from "./sidebar/PanelHeader";
import { VaultExplorer } from "./sidebar/VaultExplorer";
import { BackupReminder } from "./BackupReminder";
import { SyncBanner } from "./sync/SyncBanner";
import { DriveVaultCard, useDriveVaultHint } from "./sync/DriveVaultCard";
import { RestoreBackupDialog } from "./RestoreBackupDialog";
import { useSyncStatus } from "../../lib/vaultSync";
import { startSyncSetup } from "../../lib/syncSetupFlow";
import { useVaultPanelResize } from "../../hooks/useVaultPanelResize";

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/**
 * Sidebar "Secure Vault" panel. A thin shell: locked state, or the explorer
 * (tree, tags, trash) when unlocked, plus the storage-folder row.
 */
export function VaultPanel() {
  const unlocked = useVaultStore((s) => s.unlocked);
  const exists = useVaultStore((s) => s.exists);
  // `exists` is only known after a status check; without it an existing vault would flash "Set up".
  const [checked, setChecked] = useState(false);
  useEffect(() => { void useVaultStore.getState().refresh().finally(() => setChecked(true)); }, []);
  const data = useVaultItems();
  const custom = getVaultDir() !== null;
  const { width, dragging, handleProps } = useVaultPanelResize();

  const storageRow = (
    <div className="vt-footer-row" title={data.root ? `Stored in ${data.root}` : undefined}>
      <HardDrive size={13} className="shrink-0" aria-hidden />
      <span className="flex-1 min-w-0 truncate text-[11px]">
        {!data.root ? "…" : custom ? baseName(data.root) : "App data (default)"}
      </span>
      <button type="button" className="vt-icon-btn" style={{ width: 20, height: 20 }}
              title="Choose storage folder" aria-label="Choose storage folder" onClick={() => void pickVaultDir()}>
        <FolderOpen size={12} />
      </button>
      {custom && (
        <button type="button" className="vt-icon-btn" style={{ width: 20, height: 20 }}
                title="Use default folder" aria-label="Use default folder" onClick={resetVaultDir}>
          <RotateCcw size={11} />
        </button>
      )}
    </div>
  );

  return (
    <section className="vt-panel" aria-label="Secure Vault" style={{ width }}>
      {unlocked ? (
        <>
          <BackupReminder />
          <SyncBanner />
          <VaultExplorer {...data} footer={storageRow} />
        </>
      ) : (
        <>
          <PanelHeader unlocked={false} />
          <div data-context-area="vault-locked" className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center px-5 py-6 text-center gap-2">
            {exists || !checked ? <LockedState /> : <NoVaultState />}
          </div>
          <div className="vt-footer">{storageRow}</div>
        </>
      )}
      <div className={`vt-resize-handle${dragging ? " is-dragging" : ""}`} {...handleProps} />
    </section>
  );
}

const PRIMARY_BTN = "px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer bg-[var(--color-primary)] text-[var(--color-bg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]";
const SECONDARY_BTN = "inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] hover:border-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]";

function LockedState() {
  return (
    <div className="flex flex-col items-center gap-5 w-full max-w-[232px]" data-testid="vault-locked">
      <span className="grid place-items-center w-12 h-12 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-primary)]" aria-hidden>
        <Lock size={20} strokeWidth={1.75} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Unlock to see your secrets</h2>
        <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
          Your logins, SSH keys and notes open with your master password.
        </p>
      </div>
      <button type="button" className={`${PRIMARY_BTN} w-full inline-flex items-center justify-center gap-2 py-2`}
              onClick={() => void useVaultStore.getState().ensureUnlocked()}>
        <LockOpen size={14} aria-hidden /> Unlock
      </button>
      <p className="flex items-start gap-1.5 text-left text-[11px] leading-snug text-[var(--color-text-muted)]">
        <ShieldCheck size={13} className="shrink-0 mt-px" aria-hidden />
        Names, tags and contents stay encrypted on this device until you unlock.
      </p>
    </div>
  );
}

/**
 * No vault on this PC (F1.1): Create vault, or Use my vault from Google Drive, or restore a backup. When Google
 * Drive is already connected and holds a vault, the vault can be opened right here (F2).
 */
export function NoVaultState() {
  const status = useSyncStatus();
  const hint = useDriveVaultHint(false);
  const [restoring, setRestoring] = useState(false);
  const driveAvailable = status?.configured !== false || !!status?.provider;

  if (hint?.exists) {
    return <DriveVaultCard account={status?.account ?? null} devices={hint.devices} />;
  }
  return (
    <>
      <div className="w-10 h-10 rounded-full flex items-center justify-center bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
        <ShieldCheck size={17} aria-hidden />
      </div>
      <div className="text-[12.5px] font-semibold text-[var(--color-text)]">Set up your Secure Vault</div>
      <p className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
        Keep logins, SSH keys and private notes behind one master password.
      </p>
      <button type="button" className={`mt-1 ${PRIMARY_BTN}`} onClick={() => void useVaultStore.getState().ensureUnlocked()}>
        Create vault
      </button>
      {driveAvailable && (
        <>
          <p className="mt-2 text-[11.5px] text-[var(--color-text-muted)]">Already use Notiq on another PC?</p>
          <button type="button" className={SECONDARY_BTN} data-testid="sidebar-use-drive" onClick={() => void startSyncSetup()}>
            <Cloud size={13} aria-hidden /> Use my vault from Google Drive
          </button>
        </>
      )}
      <button type="button" className="mt-1 text-[11.5px] cursor-pointer text-[var(--color-primary)] hover:underline" onClick={() => setRestoring(true)}>
        Restore from a backup file
      </button>
      {restoring && (
        <RestoreBackupDialog
          onClose={() => {
            setRestoring(false);
            // A restored vault is locked: go straight to unlocking it.
            if (useVaultStore.getState().exists) void useVaultStore.getState().ensureUnlocked();
          }}
        />
      )}
    </>
  );
}
