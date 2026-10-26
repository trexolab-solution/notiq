import { useCallback, useEffect, useState } from "react";
import { Folder, FolderPlus, Lock } from "lucide-react";
import { exists } from "@tauri-apps/plugin-fs";
import { Modal } from "../ui/Modal";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import {
  useVaultDestStore, listVaultFolders, createVaultFolder, safeName, joinPath, getLastFolder, setLastFolder,
} from "../../lib/vaultDest";

const SUGGESTIONS = ["SSH", "Logins", "API keys"];

/** Mounted once. Asks which vault folder a note being locked should go into. */
export function VaultDestinationDialog() {
  const req = useVaultDestStore((s) => s.req);
  if (!req) return null;
  return <Inner req={req} />;
}

function Inner({ req }: { req: NonNullable<ReturnType<typeof useVaultDestStore.getState>["req"]> }) {
  const [root, setRoot]       = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [sel, setSel]         = useState("");
  const [name, setName]       = useState(() => safeName(req.name) || "Untitled");
  const [newFolder, setNewFolder] = useState("");
  const [err, setErr]         = useState<string | null>(null);

  const load = useCallback(async (select?: string) => {
    try {
      const r = await listVaultFolders();
      setRoot(r.root);
      setFolders(r.folders);
      const last = select ?? getLastFolder();
      setSel(r.folders.includes(last) ? last : "");
    } catch (e) {
      setErr(typeof e === "string" ? e : e instanceof Error ? e.message : "Can't read the vault folder");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const finish = (p: string | null) => {
    useVaultDestStore.setState({ req: null });
    req.resolve(p);
  };

  const addFolder = async (n: string) => {
    try {
      const f = await createVaultFolder(n);
      setNewFolder(""); setErr(null);
      await load(f);
    } catch (e) {
      setErr(typeof e === "string" ? e : e instanceof Error ? e.message : "Couldn't create folder");
    }
  };

  const confirm = async () => {
    const file = safeName(name);
    if (!file) { setErr("Enter a file name"); return; }
    const path = joinPath(root, sel, `${file}.nqv`);
    try {
      if (await exists(path)) { setErr(`"${file}" already exists in this folder`); return; }
    } catch { /* let the write report any real problem */ }
    setLastFolder(sel);
    finish(path);
  };

  const row = (active: boolean) =>
    `w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left cursor-pointer border ${
      active ? "border-[var(--color-primary)] bg-[var(--color-bg-tertiary)]" : "border-transparent hover:bg-[var(--color-bg-tertiary)]"}`;

  return (
    <Modal onClose={() => finish(null)} zClassName="z-[70]">
      <form
        className="w-[420px] max-w-[92vw] rounded-xl p-5 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl text-[var(--color-text)]"
        role="dialog" aria-modal="true" aria-label="Choose vault folder"
        onSubmit={(e) => { e.preventDefault(); void confirm(); }}
      >
        <div className="flex items-center gap-2 mb-1">
          <Lock size={16} style={{ color: "var(--color-primary)" }} />
          <h2 className="text-sm font-semibold">Where should this locked note go?</h2>
        </div>
        <p className="text-xs mb-3 text-[var(--color-text-muted)]">
          Notes are kept inside your vault storage folder, organised in folders.
        </p>

        <div className="max-h-44 overflow-y-auto mb-2 flex flex-col gap-0.5">
          <button type="button" className={row(sel === "")} onClick={() => setSel("")}>
            <Folder size={13} className="shrink-0" /> <span>Vault (main folder)</span>
          </button>
          {folders.map((f) => (
            <button type="button" key={f} className={row(sel === f)} onClick={() => setSel(f)}>
              <Folder size={13} className="shrink-0" /> <span className="truncate">{f}</span>
            </button>
          ))}
        </div>

        {folders.length === 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {SUGGESTIONS.map((s) => (
              <button type="button" key={s} onClick={() => void addFolder(s)}
                className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer">
                + {s}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 mb-3">
          <Input
            placeholder="New folder (e.g. SSH, Logins)" value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (newFolder.trim()) void addFolder(newFolder); } }}
          />
          <Button type="button" size="sm" icon={<FolderPlus size={12} />} disabled={!newFolder.trim()}
                  onClick={() => void addFolder(newFolder)}>Add</Button>
        </div>

        <label className="block text-xs mb-1 text-[var(--color-text-muted)]" htmlFor="vault-dest-name">File name</label>
        <Input id="vault-dest-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} />

        {err && <p role="alert" className="text-xs mt-2 text-[var(--color-danger)]">{err}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <Button type="button" onClick={() => finish(null)}>Cancel</Button>
          <Button type="submit" variant="primary">Lock here</Button>
        </div>
      </form>
    </Modal>
  );
}
