import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Folder, FilePlus2, RefreshCw, Lock, LockOpen, RotateCcw } from "lucide-react";
import { useAppStore } from "../../store";
import { useVaultStore } from "../../store/vaultStore";
import { readFileEntry } from "../../lib/fileOps";
import { ERR_LOCKED, vaultErrorMessage, vaultList, type VaultItem } from "../../lib/vault";
import { ensureVaultDir, pickVaultDir, resetVaultDir, VAULT_DIR_EVENT } from "../../lib/vaultDir";
import { getVaultDir } from "../../lib/vaultPrefs";
import { toast } from "../../lib/toast";
import { createVaultEntry, NEW_ENTRY_OPTIONS } from "../../lib/vaultCreate";

const NQV = /\.nqv$/i;
const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** Sidebar panel: the vault storage folder and the .nqv notes inside it. */
export function VaultPanel() {
  const unlocked = useVaultStore((s) => s.unlocked);
  const [dir, setDir]     = useState<string>("");
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [menu, setMenu] = useState(false);
  const custom = getVaultDir() !== null;

  const load = useCallback(async () => {
    try {
      const d = await ensureVaultDir();
      setDir(d);
      let items: VaultItem[] = [];
      try {
        items = await vaultList();
        setLocked(false);
      } catch (e) {
        if (String(e).includes(ERR_LOCKED)) setLocked(true);
        else throw e;
      }
      // Folders sort right before their children ("SSH/" < "SSH/a.nqv").
      const out = items.map((i) => (i.dir ? `${i.rel}/` : i.rel));
      setFiles(out.sort((a, b) => a.localeCompare(b)));
      setError(null);
    } catch (e) {
      setFiles([]);
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : "Can't read this folder");
    }
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener(VAULT_DIR_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener(VAULT_DIR_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, [load, unlocked]); // names are encrypted while locked: reload when the vault opens/closes

  const pathOf = (name: string) => `${dir.replace(/\\/g, "/").replace(/\/+$/, "")}/${name}`;

  const openNote = async (path: string) => {
    try {
      useAppStore.getState().openFilesAsTabs([await readFileEntry(path)]);
      if (await useVaultStore.getState().ensureUnlocked()) await useAppStore.getState().unlockVaultTabs();
    } catch (e) {
      toast.error(vaultErrorMessage(e));
    }
  };

  const iconBtn = "p-1 rounded cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]";

  return (
    <div
      style={{ width: 220, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0,
               background: "var(--color-bg-secondary)", borderRight: "1px solid var(--color-border)" }}
      aria-label="Vault storage"
    >
      <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-[var(--color-text)]">
        {unlocked ? <LockOpen size={14} style={{ color: "var(--color-primary)" }} /> : <Lock size={14} />}
        <span className="text-xs font-semibold flex-1">Secure Vault</span>
        <div className="relative">
          <button className={iconBtn} title="New secret…" aria-label="New secret" aria-haspopup="menu" aria-expanded={menu}
                  onClick={() => setMenu((v) => !v)}>
            <FilePlus2 size={14} />
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
              <div role="menu" className="absolute left-0 top-full mt-1 z-50 w-56 rounded-lg p-1 shadow-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                {NEW_ENTRY_OPTIONS.map((o) => (
                  <button key={o.kind} role="menuitem" type="button"
                          className="w-full text-left px-2 py-1.5 rounded cursor-pointer hover:bg-[var(--color-bg-tertiary)]"
                          onClick={() => { setMenu(false); void createVaultEntry(o.kind).then(load); }}>
                    <div className="text-xs font-medium text-[var(--color-text)]">{o.label}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">{o.hint}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button className={iconBtn} title="Refresh" aria-label="Refresh" onClick={() => void load()}>
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="flex items-center gap-1 px-3 pb-2">
        <span className="text-[11px] flex-1 truncate text-[var(--color-text-muted)]" title={dir}>
          {dir ? baseName(dir) : "…"}{custom ? "" : " (default)"}
        </span>
        <button className={iconBtn} title="Choose storage folder" aria-label="Choose storage folder"
                onClick={() => void pickVaultDir()}>
          <FolderOpen size={13} />
        </button>
        {custom && (
          <button className={iconBtn} title="Use default folder" aria-label="Use default folder" onClick={resetVaultDir}>
            <RotateCcw size={12} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {locked && !error && (
          <div className="px-2 text-xs text-[var(--color-text-muted)]">
            <p>Unlock to see your secrets.</p>
            <button type="button" className="mt-2 px-2.5 py-1 rounded cursor-pointer border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                    onClick={() => void useVaultStore.getState().ensureUnlocked()}>
              Unlock
            </button>
          </div>
        )}
        {error && <p className="px-2 text-xs text-[var(--color-danger)]">{error}</p>}
        {!error && !locked && !files.some((f) => !f.endsWith("/")) && (
          <p className="px-2 text-xs text-[var(--color-text-muted)]">
            No locked notes here yet. Use + to create one, or right-click a tab → Lock with Vault.
          </p>
        )}
        {files.map((rel) => {
          const isDir = rel.endsWith("/");
          const parts = rel.replace(/\/$/, "").split("/");
          const indent = (parts.length - 1) * 12;
          const label = parts[parts.length - 1];
          if (isDir) {
            return (
              <div key={rel} className="flex items-center gap-1.5 px-2 pt-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
                   style={{ paddingLeft: 8 + indent }}>
                <Folder size={11} className="shrink-0" /> <span className="truncate">{label}</span>
              </div>
            );
          }
          return (
            <button
              key={rel}
              onClick={() => void openNote(pathOf(rel))}
              title={rel}
              style={{ paddingLeft: 8 + indent }}
              className="w-full flex items-center gap-2 pr-2 py-1.5 rounded text-left text-xs cursor-pointer text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
            >
              <Lock size={12} className="shrink-0 text-[var(--color-text-muted)]" />
              <span className="truncate flex-1">{label.replace(NQV, "")}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
