import { useEffect, useState } from "react";
import { Cloud, Lock, ShieldCheck } from "lucide-react";
import { LockHero } from "./LockHero";
import { useVaultStore } from "../../store/vaultStore";
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


/**
 * Sidebar "Secure Vault" panel. A thin shell: locked state, or the explorer
 * (tree, tags, trash) when unlocked. The storage folder is chosen in Settings → Vault.
 */
export function VaultPanel() {
  const unlocked = useVaultStore((s) => s.unlocked);
  const exists = useVaultStore((s) => s.exists);
  // `exists` is only known after a status check; without it an existing vault would flash "Set up".
  const [checked, setChecked] = useState(false);
  useEffect(() => { void useVaultStore.getState().refresh().finally(() => setChecked(true)); }, []);
  const data = useVaultItems();
  const { width, dragging, handleProps } = useVaultPanelResize();

  return (
    <section className="vt-panel" aria-label="Secure Vault" style={{ width }}>
      {unlocked ? (
        <>
          <BackupReminder />
          <SyncBanner />
          <VaultExplorer {...data} />
        </>
      ) : (
        <>
          <PanelHeader unlocked={false} />
          <div data-context-area="vault-locked" className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center px-5 py-6 text-center gap-2">
            {exists || !checked ? <LockedState /> : <NoVaultState />}
          </div>
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
    <div className="flex justify-center w-full" data-testid="vault-locked">
      <LockHero icon={Lock} title="Unlock to see your secrets" action="Unlock"
                text="Your logins, SSH keys and notes open with your master password."
                onUnlock={() => { void useVaultStore.getState().ensureUnlocked(); }}
                note="Names, tags and contents stay encrypted on this device until you unlock." />
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
