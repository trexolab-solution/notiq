import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, FileQuestion, RefreshCw, Save } from "lucide-react";
import { DialogButton } from "../ui/Dialog";
import { RowIconButton } from "../vault/ListEditor";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SegmentedControl } from "../ui/SegmentedControl";
import { MarkdownView } from "./MarkdownView";
import { CsvTable } from "./CsvTable";
import { previewKind } from "../../lib/remotePreview";
import { toast } from "../../lib/toast";
import { getFilesPrefs } from "../../lib/filesPrefs";
import { formatBytes } from "../../lib/vaultBackup";
import { getLanguageFromPath } from "../../lib/language";
import {
  bytesFromBase64, decodeText, imageMime, isPdf, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MAX_TEXT_BYTES, sftpErrorMessage, sftpRead, sftpWrite,
  SFTP_CHANGED, SFTP_TOO_BIG,
} from "../../lib/sftp";

// Monaco is big; it loads the first time a text file is opened.
const Editor = lazy(() => import("@monaco-editor/react"));

type Loaded =
  | { kind: "loading" }
  | { kind: "image"; url: string; bytes: number }
  | { kind: "pdf"; url: string; bytes: number }
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
 * Opens a remote file inside the file manager: pictures and PDFs are shown, text is edited in the editor and saved straight
 * back to the server. A Markdown file also opens as a page (Edit / Preview) and a CSV or TSV file as a table (Text /
 * Table); the preview follows what is typed, saved or not. Anything else (binary, too big) says so and offers the download.
 */
export function RemoteFileViewer({ session, path, name, onClose, onDownload, onSaved }: Props) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  /** True from a successful save until the next edit, for the "All changes saved" status. */
  const [justSaved, setJustSaved] = useState(false);
  const [confirm, setConfirm] = useState<"discard" | "overwrite" | null>(null);
  const mtime = useRef<number | null>(null);
  const urlRef = useRef<string | null>(null);

  const dirty = loaded.kind === "text" && draft !== saved;
  const mime = useMemo(() => imageMime(name), [name]);
  const pdf = useMemo(() => isPdf(name), [name]);
  /** The most the file may be to open here, by what it is. */
  const limit = pdf ? MAX_PDF_BYTES : mime ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
  /** How the text can also be shown (a page, a table), and which of the two views is open: a preview first. */
  const kind = useMemo(() => previewKind(name), [name]);
  const [view, setView] = useState<"edit" | "preview">("preview");
  const previewing = kind != null && view === "preview";
  const prefs = useMemo(() => getFilesPrefs(), []);

  const load = useCallback(async () => {
    setLoaded({ kind: "loading" });
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    try {
      const r = await sftpRead(session, path, limit);
      const bytes = bytesFromBase64(r.data);
      if (pdf) {
        // The system's own PDF viewer shows it (pages, zoom, search, print), from a blob address made here.
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
        urlRef.current = url;
        setLoaded({ kind: "pdf", url, bytes: bytes.length });
        return;
      }
      if (mime) {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
        urlRef.current = url;
        setLoaded({ kind: "image", url, bytes: bytes.length });
        return;
      }
      const text = decodeText(bytes);
      if (text === null) { setLoaded({ kind: "unsupported", why: "This is a binary file, so it can't be shown as text. Download it to open it." }); return; }
      mtime.current = r.mtime;
      setDraft(text); setSaved(text);
      setLoaded({ kind: "text", text, mtime: r.mtime });
    } catch (e) {
      const m = sftpErrorMessage(e);
      setLoaded({ kind: "unsupported", why: m === SFTP_TOO_BIG
        ? `This file is too large to open here (the limit is ${formatBytes(limit)}). Download it instead.` : m });
    }
  }, [session, path, mime, pdf, limit]);

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
      setJustSaved(true);
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
        <span className="flex-1 min-w-0 truncate text-sm font-medium">
          {name}
        </span>
        {loaded.kind === "text" && kind && (
          <SegmentedControl<"edit" | "preview"> aria-label={kind === "markdown" ? "Markdown view" : "CSV view"} value={view} onChange={setView}
            options={kind === "markdown" ? [{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }] : [{ value: "edit", label: "Text" }, { value: "preview", label: "Table" }]} />
        )}
        {loaded.kind === "text" && (
          <span className={`shrink-0 text-xs ${dirty ? "text-[var(--color-warning,#d97706)]" : "text-[var(--color-text-muted)]"}`} role="status">
            {saving ? "Saving…" : dirty ? "Unsaved changes" : justSaved ? "All changes saved" : ""}
          </span>
        )}
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
        {loaded.kind === "pdf" && (
          <iframe title={name} src={loaded.url} className="absolute inset-0 h-full w-full border-0 bg-[var(--color-bg-secondary)]" />
        )}
        {loaded.kind === "text" && previewing && kind === "markdown" && <MarkdownView text={draft} />}
        {loaded.kind === "text" && previewing && kind === "table" && <CsvTable text={draft} name={name} />}
        {loaded.kind === "text" && !previewing && (
          <Suspense fallback={<p className="absolute inset-0 grid place-items-center text-sm text-[var(--color-text-muted)]">Loading the editor…</p>}>
            <Editor value={draft} language={getLanguageFromPath(name)} theme={light ? "vs" : "vs-dark"}
                    onChange={(v) => { setDraft(v ?? ""); setJustSaved(false); }}
                    options={{ minimap: { enabled: false }, fontSize: prefs.editorFontSize, wordWrap: prefs.editorWrap ? "on" : "off", scrollBeyondLastLine: false, automaticLayout: true }} />
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
        <ConfirmDialog title="Discard unsaved changes?" message={`Your changes to \u201c${name}\u201d haven't been saved to the server and will be lost.`}
                       confirmLabel="Discard changes" cancelLabel="Keep editing" danger
                       onConfirm={() => { setConfirm(null); setDraft(saved); onClose(); }} onCancel={() => setConfirm(null)} />
      )}
      {confirm === "overwrite" && (
        <ConfirmDialog title="This file changed on the server" message={`\u201c${name}\u201d was modified on the server after you opened it. If you save now, those newer changes are overwritten by your version.`}
                       confirmLabel="Overwrite" cancelLabel="Cancel" danger
                       onConfirm={() => { setConfirm(null); void save(true); }} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}
