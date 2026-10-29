import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { AlertTriangle, FileUp, X } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { useVaultStore } from "../../store/vaultStore";
import { useAppStore } from "../../store";
import {
  VAULT_CHANGED_EVENT, vaultErrorMessage, vaultList, vaultMkdir, vaultReadFile, vaultWriteFile, type VaultItem,
} from "../../lib/vault";
import { allFolders, toFull } from "../../lib/vaultTree";
import { LOGIN_EXT, parseLogin, serializeLogin } from "../../lib/loginEntry";
import { readAllLogins, type StoredLogin } from "../../lib/vaultHealth";
import {
  executeImport, FIELD_LABEL, FIELDS, FORMAT_LABEL, mappingUsable, parseImport, planCounts, planImport, toImportRows,
  type ColumnMap, type DupPolicy, type ImportResult, type ParsedImport,
} from "../../lib/csvImport";

const MAX_FILE_CHARS = 50 * 1024 * 1024;
const PREVIEW_ROWS = 50;

type Stage = "pick" | "review" | "running" | "done";

/** Writes a login without the per-file "saved" event (5000 events would reload the sidebar 5000 times). */
const writeQuiet = (path: string, content: string) => invoke<void>("vault_write_file", { path, content, ext: LOGIN_EXT });

/** Import logins from a browser / password-manager CSV export. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [stage, setStage] = useState<Stage>("pick");
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [map, setMap] = useState<ColumnMap | null>(null);
  const [policy, setPolicy] = useState<DupPolicy>("skip");
  const [baseFolder, setBaseFolder] = useState("Imported");
  const [useFolders, setUseFolders] = useState(true);
  const [vault, setVault] = useState<{ root: string; items: VaultItem[]; existing: StoredLogin[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<ImportResult | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const unlocked = useVaultStore((s) => s.unlocked);
  useEffect(() => { if (!unlocked && stage !== "running") onClose(); }, [unlocked, stage, onClose]);

  const pickFile = async () => {
    setError(null);
    try {
      const path = await open({ multiple: false, directory: false, title: "Choose a passwords CSV file",
        filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }] });
      if (typeof path !== "string") return;
      setBusy(true);
      const text = await readTextFile(path);
      if (text.length > MAX_FILE_CHARS) throw new Error("That file is too large to import");
      const p = parseImport(text);
      if (!p.header.length || !p.records.length) throw new Error("That file has no rows to import");
      const isUnlocked = () => useVaultStore.getState().unlocked;
      const [{ root, logins }, items] = await Promise.all([readAllLogins(isUnlocked), vaultList()]);
      if (!alive.current) return;
      setVault({ root, items, existing: logins });
      setFileName(path.split(/[\\/]/).pop() ?? path);
      setParsed(p); setMap(p.map);
      setStage("review");
    } catch (e) {
      setError(vaultErrorMessage(e) || "Couldn't read that file");
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const converted = useMemo(() => (parsed && map ? toImportRows(parsed, map) : null), [parsed, map]);
  const steps = useMemo(() => {
    if (!converted || !vault) return null;
    return planImport(converted.rows, { policy, baseFolder, useSourceFolders: useFolders, items: vault.items, existing: vault.existing });
  }, [converted, vault, policy, baseFolder, useFolders]);
  const counts = steps ? planCounts(steps) : null;
  const hasFolders = !!converted?.rows.some((r) => r.folder);
  const dupCount = steps ? steps.filter((s) => s.action !== "create").length : 0;

  const runImport = async () => {
    if (!steps || !vault) return;
    setStage("running"); setProgress({ done: 0, total: steps.length });
    const { root } = vault;
    const res = await executeImport(steps, allFolders(vault.items), {
      mkdir: (rel) => vaultMkdir(toFull(root, rel)),
      create: (rel, content) => writeQuiet(toFull(root, rel), content),
      updatePassword: async (path, password) => {
        const f = await vaultReadFile(path);
        await vaultWriteFile(path, serializeLogin({ ...parseLogin(f.content), password }), LOGIN_EXT);
      },
      yieldToUi: () => new Promise((r) => setTimeout(r, 0)),
      shouldContinue: () => useVaultStore.getState().unlocked,
    }, (done, total) => { if (alive.current) setProgress({ done, total }); });
    window.dispatchEvent(new Event("vault:file-saved"));
    window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
    void useAppStore.getState().refreshVaultTabs().catch(() => {});
    if (!alive.current) return;
    setResult(res); setStage("done");
  };

  const warning = (
    <div className="flex gap-2 rounded-lg border border-[var(--color-warning)] px-3 py-2 text-xs">
      <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: "var(--color-warning)" }} aria-hidden />
      <span>
        Export files hold your passwords in plain text. After importing, delete the CSV file (and empty your
        system's trash). Notiq never deletes or uploads it for you.
      </span>
    </div>
  );

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Modal onClose={() => { if (stage !== "running") onClose(); }} dismissable={stage !== "running"} zClassName="z-[70]">
      <div role="dialog" aria-modal="true" aria-label="Import logins"
           className="w-[720px] max-w-[94vw] max-h-[88vh] flex flex-col rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl text-[var(--color-text)]">
        <div className="flex items-center gap-2 px-5 pt-4 pb-2">
          <FileUp size={18} style={{ color: "var(--color-primary)" }} aria-hidden />
          <h2 className="text-sm font-semibold flex-1">Import logins from CSV</h2>
          {stage !== "running" && (
            <button type="button" className="vt-icon-btn" aria-label="Close" onClick={onClose}><X size={14} /></button>
          )}
        </div>

        <div className="px-5 pb-4 flex-1 min-h-0 overflow-auto flex flex-col gap-3 text-xs">
          {stage === "pick" && (
            <>
              <p className="text-[var(--color-text-muted)]">
                Supports password exports from Chrome, Edge and Brave (passwords.csv), Bitwarden and KeePass, plus any
                other CSV where you choose which column is which. The file is read on this device only.
              </p>
              {warning}
              {error && <div role="alert" className="text-[var(--color-danger)]">{error}</div>}
              <div className="flex justify-end gap-2">
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="primary" disabled={busy} onClick={() => void pickFile()}>{busy ? "Reading…" : "Choose CSV file…"}</Button>
              </div>
            </>
          )}

          {stage === "review" && parsed && map && converted && counts && (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span><span className="text-[var(--color-text-muted)]">File:</span> {fileName}</span>
                <span><span className="text-[var(--color-text-muted)]">Format:</span> {FORMAT_LABEL[parsed.format]}</span>
                <span><span className="text-[var(--color-text-muted)]">Rows:</span> {parsed.records.length}</span>
                <span><span className="text-[var(--color-text-muted)]">Logins:</span> {converted.rows.length}</span>
                {converted.skipped.length > 0 && (
                  <span><span className="text-[var(--color-text-muted)]">Ignored:</span> {converted.skipped.length}</span>
                )}
              </div>

              {parsed.format === "generic" && (
                <fieldset className="rounded-lg border border-[var(--color-border)] p-3">
                  <legend className="px-1 font-medium">Match the columns</legend>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {FIELDS.map((f) => (
                      <label key={f} className="flex flex-col gap-1">
                        <span className="text-[var(--color-text-muted)]">{FIELD_LABEL[f]}</span>
                        <select value={map[f]} onChange={(e) => setMap({ ...map, [f]: Number(e.target.value) })}
                                className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-1">
                          <option value={-1}>(none)</option>
                          {parsed.header.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                  {!mappingUsable(map) && (
                    <div className="mt-2 text-[var(--color-danger)]">Choose the Password column and a Website or Username column.</div>
                  )}
                </fieldset>
              )}

              <div className="overflow-auto max-h-56 rounded-lg border border-[var(--color-border)]">
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-[var(--color-bg-tertiary)]">
                    <tr>{["Name", "Website", "Username", "Password", "Folder"].map((h) => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {converted.rows.slice(0, PREVIEW_ROWS).map((r) => (
                      <tr key={r.line} className="border-t border-[var(--color-border)]">
                        <td className="px-2 py-1 max-w-[140px] truncate">{r.title}</td>
                        <td className="px-2 py-1 max-w-[180px] truncate">{r.url}</td>
                        <td className="px-2 py-1 max-w-[140px] truncate">{r.username}</td>
                        <td className="px-2 py-1 text-[var(--color-text-muted)]">{r.password ? "••••••••" : "(empty)"}</td>
                        <td className="px-2 py-1 max-w-[120px] truncate">{r.folder}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {converted.rows.length > PREVIEW_ROWS && (
                  <div className="px-2 py-1 text-[var(--color-text-muted)]">…and {converted.rows.length - PREVIEW_ROWS} more</div>
                )}
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <fieldset className="flex flex-col gap-1">
                  <legend className="font-medium mb-1">Same site and username already saved</legend>
                  {([["skip", "Skip"], ["update", "Update the password"], ["keep", "Keep both"]] as [DupPolicy, string][]).map(([v, l]) => (
                    <label key={v} className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name="dup" checked={policy === v} onChange={() => setPolicy(v)} /> {l}
                    </label>
                  ))}
                </fieldset>
                <div className="flex flex-col gap-1">
                  <label className="flex flex-col gap-1">
                    <span className="font-medium">Import into folder</span>
                    <input value={baseFolder} onChange={(e) => setBaseFolder(e.target.value)} placeholder="(vault root)"
                           className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1" />
                  </label>
                  {hasFolders && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={useFolders} onChange={(e) => setUseFolders(e.target.checked)} />
                      Keep the export's folders (as {baseFolder.trim() ? `${baseFolder.trim()}/<folder>` : "<folder>"})
                    </label>
                  )}
                </div>
              </div>

              <div className="text-[var(--color-text-muted)]">
                Will create {counts.create}, update {counts.update}, skip {counts.skip}
                {dupCount ? ` (${dupCount} duplicate${dupCount === 1 ? "" : "s"})` : ""}.
              </div>
              {warning}
              <div className="flex justify-end gap-2">
                <Button onClick={() => { setStage("pick"); setParsed(null); }}>Back</Button>
                <Button variant="primary" disabled={!mappingUsable(map) || counts.create + counts.update === 0}
                        onClick={() => void runImport()}>
                  Import {counts.create + counts.update} login{counts.create + counts.update === 1 ? "" : "s"}
                </Button>
              </div>
            </>
          )}

          {stage === "running" && (
            <div className="flex flex-col gap-2 py-4" aria-live="polite">
              <div>Importing… {progress.done} of {progress.total}</div>
              <div className="h-2 rounded bg-[var(--color-bg-tertiary)] overflow-hidden" role="progressbar"
                   aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <div className="h-full bg-[var(--color-primary)] transition-[width]" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          {stage === "done" && result && (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span>Created <strong>{result.created}</strong></span>
                <span>Updated <strong>{result.updated}</strong></span>
                <span>Skipped <strong>{result.skipped}</strong></span>
                {result.failed.length > 0 && <span className="text-[var(--color-danger)]">Failed <strong>{result.failed.length}</strong></span>}
              </div>
              {result.aborted && <div className="text-[var(--color-danger)]">The vault locked, so the import stopped early.</div>}
              {(result.failed.length > 0 || (converted?.skipped.length ?? 0) > 0) && (
                <div className="max-h-48 overflow-auto rounded-lg border border-[var(--color-border)] p-2">
                  {result.failed.map((f, i) => (
                    <div key={`f${i}`} className="text-[var(--color-danger)]">Line {f.line} ({f.name}): {f.error}</div>
                  ))}
                  {converted?.skipped.map((s, i) => (
                    <div key={`s${i}`} className="text-[var(--color-text-muted)]">Line {s.line}: {s.reason}</div>
                  ))}
                </div>
              )}
              {warning}
              <div className="flex justify-end">
                <Button variant="primary" onClick={onClose}>Done</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
