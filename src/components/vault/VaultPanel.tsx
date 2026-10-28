import { useEffect, useState } from "react";
import { FolderOpen, HardDrive, Lock, RotateCcw, ShieldCheck } from "lucide-react";
import { useVaultStore } from "../../store/vaultStore";
import { pickVaultDir, resetVaultDir } from "../../lib/vaultDir";
import { getVaultDir } from "../../lib/vaultPrefs";
import { useVaultItems } from "./sidebar/useVaultItems";
import { PanelHeader } from "./sidebar/PanelHeader";
import { VaultExplorer } from "./sidebar/VaultExplorer";

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

  const storageRow = (
    <div className="vt-footer-row" title={data.root ? `Stored in ${data.root}` : undefined}>
      <HardDrive size={13} className="shrink-0" aria-hidden />
      <span className="flex-1 min-w-0 truncate text-[11px]">
        {data.root ? baseName(data.root) : "…"}{custom ? "" : " (default)"}
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
    <section className="vt-panel" aria-label="Secure Vault">
      {unlocked ? (
        <VaultExplorer {...data} footer={storageRow} />
      ) : (
        <>
          <PanelHeader unlocked={false} />
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-5 text-center gap-2">
            <div className="w-10 h-10 rounded-full flex items-center justify-center bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
              {exists || !checked ? <Lock size={17} aria-hidden /> : <ShieldCheck size={17} aria-hidden />}
            </div>
            <div className="text-[12.5px] font-semibold text-[var(--color-text)]">
              {exists || !checked ? "Unlock to see your secrets" : "Set up your Secure Vault"}
            </div>
            <p className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
              {exists || !checked
                ? "Names, tags and contents are encrypted with your master password."
                : "Keep logins, SSH keys, API keys and private notes behind one master password. Everything is encrypted and stays on this device."}
            </p>
            <button
              type="button"
              className="mt-1 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer bg-[var(--color-primary)] text-[var(--color-bg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
              onClick={() => void useVaultStore.getState().ensureUnlocked()}
            >
              {exists || !checked ? "Unlock" : "Create vault"}
            </button>
          </div>
          <div className="vt-footer">{storageRow}</div>
        </>
      )}
    </section>
  );
}
