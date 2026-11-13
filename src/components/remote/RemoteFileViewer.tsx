import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, FileQuestion, RefreshCw, Save } from "lucide-react";
import { DialogButton } from "../ui/Dialog";
import { RowIconButton } from "../vault/ListEditor";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { toast } from "../../lib/toast";
import { formatBytes } from "../../lib/vaultBackup";
import { getLanguageFromPath } from "../../lib/language";
import {
  bytesFromBase64, decodeText, imageMime, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, sftpErrorMessage, sftpRead, sftpWrite,
  SFTP_CHANGED, SFTP_TOO_BIG,
} from "../../lib/sftp";

// Monaco is big; it loads the first time a text file is opened.
const Editor = lazy(() => import("@monaco-editor/react"));

type Loaded =
  | { kind: "loading" }
  | { kind: "image"; url: string; bytes: number }
  | { kind: "text"; text: string; mtime: number | null }
  | { kind: "unsupported"; why: string };

interface Props {
  /** The open connection and the file's full remote path. */
  session: number;
  path: string;
  name: string;
  /** Back to the folder (called after any unsaved-changes question was answered). */
  onClose: () => void;
  onDownload: () => void;
  /** The file was saved: the folder's size and date columns are stale. */
  onSaved: () => void;
}

/**
 * Opens a remote file inside the file manager: pictures are shown, text is edited in the editor and saved straight
 * back to the server. Anything else (binary, too big) says so and offers the download.
 */
export function RemoteFileViewer({ session, path, name, onClose, onDownload, onSaved }: Props) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<"discard" | "overwrite" | null>(null);
  const mtime = useRef<number | null>(null);
  const urlRef = useRef<string | null>(null);

  const dirty = loaded.kind === "text" && draft !== saved;
  const mime = useMemo(() => imageMime(name), [name]);

  const load = useCallback(async () => {
    setLoaded({ kind: "loading" });
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    try {
      const r = await sftpRead(session, path, mime ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES);
      const bytes = bytesFromBase64(r.data);
      if (mime) {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
        urlRef.current = url;
        setLoaded({ kind: "image", url, bytes: bytes.length });
        return;
      }
      const text = decodeText(bytes);
      if (text === null) { setLoaded({ kind: "unsupported", why: "This looks like a binary file, so it can't be shown as text." }); return; }
      mtime.current = r.mtime;
      setDraft(text); setSaved(text);
      setLoaded({ kind: "text", text, mtime: r.mtime });
    } catch (e) {
      const m = sftpErrorMessage(e);
      setLoaded({ kind: "unsupported", why: m === SFTP_TOO_BIG
        ? `This file is too big to open here (over ${formatBytes(mime ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES)}).` : m });
    }
  }, [session, path, mime]);

  useEffect(() => {
    void load();
    return () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); };
  }, [load]);

  const save = useCallback(async (force = false) => {
    if (loaded.kind !== "text" || saving) return;
    setSaving(true);
    try {
      mtime.current = await sftpWrite(session, path, draft, mtime.current, force);
      setSaved(draft);
      toast.success(`Saved ${name}`);
      onSaved();
    } catch (e) {
      if (sftpErrorMessage(e) === SFTP_CHANGED) setConfirm("overwrite");
      else toast.error(sftpErrorMessage(e));
    } finally { setSaving(false); }
  }, [loaded.kind, saving, session, path, draft, name, onSaved]);

  const close = () => { if (dirty) setConfirm("discard"); else onClose(); };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
    else if (e.key === "Escape" && !confirm) { e.stopPropagation(); close(); }
  };

  const light = (() => { try { return localStorage.getItem("pref:theme") === "light"; } catch { return false; } })();

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-[var(--color-bg)]" role="region" aria-label={`Viewing ${name}`} onKeyDown={onKey}>
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--color-border)]" role="toolbar" aria-label="File actions">
        <RowIconButton label="Back" tooltip="Back to the folder (Esc)" icon={<ArrowLeft size={15} />} onClick={close} />
        <span className="w-px h-5 mx-1.5 bg-[var(--color-border)]" aria-hidden />
        <span className="flex-1 min-w-0 truncate text-sm font-medium" title={path}>
          {name}{dirty && <span className="ml-1.5 text-[var(--color-warning,#d97706)]" aria-label="unsaved changes">●</span>}
        </span>
        <RowIconButton label="Reload" tooltip="Reload from the server" icon={<RefreshCw size={15} />} disabled={dirty} onClick={() => void load()} />
        <RowIconButton label="Download" icon={<Download size={15} />} onClick={onDownload} />
        {loaded.kind === "text" && (
          <RowIconButton label="Save" tooltip={saving ? "Saving…" : "Save to the server (Ctrl+S)"} icon={<Save size={15} />} disabled={!dirty || saving}
                         className={dirty ? "!bg-[var(--color-primary)] !text-[var(--color-bg)] hover:!bg-[var(--color-primary-hover)]" : ""} onClick={() => void save()} />
        )}
      </div>

      <div className="flex-1 min-h-0 relative">
        {loaded.kind === "loading" && <p className="m-auto absolute inset-0 grid place-items-center text-sm text-[var(--color-text-muted)]" role="status">Opening {name}…</p>}
        {loaded.kind === "image" && (
          <div className="absolute inset-0 overflow-auto grid place-items-center p-4 bg-[var(--color-bg-secondary)]">
            <img src={loaded.url} alt={name} className="max-w-full max-h-full object-contain" draggable={false} />
          </div>
        )}
        {loaded.kind === "text" && (
          <Suspense fallback={<p className="absolute inset-0 grid place-items-center text-sm text-[var(--color-text-muted)]">Loading the editor…</p>}>
            <Editor value={draft} language={getLanguageFromPath(name)} theme={light ? "vs" : "vs-dark"}
                    onChange={(v) => setDraft(v ?? "")}
                    options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: "on", scrollBeyondLastLine: false, automaticLayout: true }} />
          </Suspense>
        )}
        {loaded.kind === "unsupported" && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <div>
              <FileQuestion size={28} className="mx-auto text-[var(--color-text-muted)]" aria-hidden />
              <p className="mt-3 text-sm">{loaded.why}</p>
              <div className="mt-4 flex justify-center"><DialogButton variant="primary" icon={<Download size={13} />} onClick={onDownload}>Download</DialogButton></div>
            </div>
          </div>
        )}
      </div>

      {confirm === "discard" && (
        <ConfirmDialog title="Discard your changes?" message={`${name} has changes that aren't saved to the server.`}
                       confirmLabel="Discard" cancelLabel="Keep editing" danger
                       onConfirm={() => { setConfirm(null); setDraft(saved); onClose(); }} onCancel={() => setConfirm(null)} />
      )}
      {confirm === "overwrite" && (
        <ConfirmDialog title="The file changed on the server" message={`${name} was changed by someone or something else since you opened it. Saving replaces their version with yours.`}
                       confirmLabel="Overwrite" cancelLabel="Cancel" danger
                       onConfirm={() => { setConfirm(null); void save(true); }} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}
