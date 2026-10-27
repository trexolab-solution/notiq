import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Folder, FilePlus2, RefreshCw, Lock, LockOpen, RotateCcw, CloudUpload } from "lucide-react";
import { readDir } from "@tauri-apps/plugin-fs";
import { useAppStore } from "../../store";
import { useVaultStore } from "../../store/vaultStore";
import { readFileEntry } from "../../lib/fileOps";
import { vaultErrorMessage } from "../../lib/vault";
import { ensureVaultDir, pickVaultDir, resetVaultDir, VAULT_DIR_EVENT } from "../../lib/vaultDir";
import { getVaultDir } from "../../lib/vaultPrefs";
import { toast } from "../../lib/toast";
import { createVaultEntry, NEW_ENTRY_OPTIONS } from "../../lib/vaultCreate";
import { backupDismissedForever } from "../../lib/backupPrompt";
import { TG_EVENT, FILE_SAVED_EVENT, errText, runSync, tgStatus, tgSyncState } from "../../lib/telegram";

const NQV = /\.nqv$/i;
const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** Sidebar panel: the vault storage folder and the .nqv notes inside it. */
export function VaultPanel() {
  const unlocked = useVaultStore((s) => s.unlocked);
  const [dir, setDir]     = useState<string>("");
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [tg, setTg] = useState(false);
  const [tgKnown, setTgKnown] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [states, setStates] = useState<Record<string, string>>({});
  const custom = getVaultDir() !== null;

  const load = useCallback(async () => {
    try {
      const d = await ensureVaultDir();
      setDir(d);
      const out: string[] = [];
      const walk = async (rel: string, depth: number) => {
        const entries = await readDir(rel ? `${d.replace(/\\/g, "/").replace(/\/+$/, "")}/${rel}` : d);
        for (const e of entries) {
          if (e.isFile && NQV.test(e.name)) out.push(rel ? `${rel}/${e.name}` : e.name);
          else if (e.isDirectory && depth < 3 && !e.name.startsWith(".")) {
            const sub = rel ? `${rel}/${e.name}` : e.name;
            out.push(`${sub}/`); // keeps empty folders visible
            await walk(sub, depth + 1);
          }
        }
      };
      await walk("", 0);
      setFiles(out.sort((a, b) => a.localeCompare(b)));
      try {
        const s = await tgStatus();
        setTg(s.configured);
        setTgKnown(true);
        const m: Record<string, string> = {};
        if (s.configured) for (const f of await tgSyncState(d)) m[f.rel] = f.state;
        setStates(m);
      } catch { setTg(false); setStates({}); }
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
    window.addEventListener(TG_EVENT, load);
    window.addEventListener(FILE_SAVED_EVENT, load);
    return () => {
      window.removeEventListener(TG_EVENT, load);
      window.removeEventListener(FILE_SAVED_EVENT, load);
      window.removeEventListener(VAULT_DIR_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  const pathOf = (name: string) => `${dir.replace(/\\/g, "/").replace(/\/+$/, "")}/${name}`;

  const openNote = async (path: string) => {
    try {
      useAppStore.getState().openFilesAsTabs([await readFileEntry(path)]);
      if (await useVaultStore.getState().ensureUnlocked()) await useAppStore.getState().unlockVaultTabs();
    } catch (e) {
      toast.error(vaultErrorMessage(e));
    }
  };

  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const r = await runSync();
      if (r) toast.info(`Sync: ${r.uploaded} uploaded, ${r.downloaded.length} downloaded, ${r.skipped} unchanged`);
      if (r?.failed.length) toast.error(r.failed[0]);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setSyncing(false);
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
        {tg && (
          <button className={iconBtn} title="Sync now" aria-label="Sync now"
                  disabled={syncing} onClick={() => void syncNow()}>
            <CloudUpload size={14} />
          </button>
        )}
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

      {tgKnown && !tg && !backupDismissedForever() && (
        <div className="mx-3 mb-2 rounded-md p-2 text-[11px] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
          <b className="text-[var(--color-text)]">Not backed up.</b> These notes exist only on this computer.
          <button type="button" className="block mt-1 underline cursor-pointer text-[var(--color-text)]"
                  onClick={() => useVaultStore.getState().setBackupPrompt(true)}>
            Set up backup
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {error && <p className="px-2 text-xs text-[var(--color-danger)]">{error}</p>}
        {!error && !files.some((f) => !f.endsWith("/")) && (
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
              {tg && (
                <span
                  title={states[rel] === "synced" ? "Backed up" : states[rel] === "modified" ? "Changed since backup" : "Not backed up yet"}
                  style={{ width: 6, height: 6, borderRadius: 99, flexShrink: 0,
                           background: states[rel] === "synced" ? "#3fb950" : "#d29922" }}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
