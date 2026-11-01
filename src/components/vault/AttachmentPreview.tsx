import { useEffect, useState } from "react";
import {
  Download, File, FileArchive, FileCode, FileHeadphone, FileImage, FileKey, FileSpreadsheet, FileText, FileType,
  FileVideoCamera, type LucideIcon,
} from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { Spinner } from "../ui/Loading";
import { attachmentKind, extOf, previewMode, type AttachmentKind } from "../../lib/attachmentKinds";
import { formatBytes } from "../../lib/vaultBackup";
import { base64ToBytes, vaultAttachGet, vaultErrorMessage, type VaultAttachment } from "../../lib/vault";

const KIND_ICON: Record<AttachmentKind, LucideIcon> = {
  image: FileImage, text: FileText, code: FileCode, key: FileKey, pdf: FileType, archive: FileArchive,
  audio: FileHeadphone, video: FileVideoCamera, sheet: FileSpreadsheet, doc: FileText, other: File,
};

/** File-type glyph for an attachment (decorative: the name is always shown next to it). */
export function AttachmentIcon({ name, mime, size = 16, className = "" }: { name: string; mime?: string; size?: number; className?: string }) {
  const kind = attachmentKind(name, mime);
  const Icon = KIND_ICON[kind];
  return <Icon size={size} aria-hidden data-kind={kind} className={`shrink-0 ${className}`} />;
}

/** Longest text shown; the rest is cut off (Save as gives the whole file). */
const MAX_TEXT_CHARS = 200_000;

type View = { kind: "loading" } | { kind: "image"; url: string } | { kind: "text"; text: string; cut: boolean } | { kind: "error"; message: string };

/**
 * "Open" for an attachment: shows an image or text file inside the app. The file is decrypted into memory
 * only (an object URL that is revoked on close), never written to disk.
 */
export function AttachmentPreview({ path, attachment: a, onClose, onSave }: {
  path: string; attachment: VaultAttachment; onClose: () => void; onSave: () => void;
}) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const mode = previewMode(a.name, a.mime);

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    vaultAttachGet(path, a.id).then((b64) => {
      if (!alive) return;
      const bytes = base64ToBytes(b64);
      if (mode === "image") {
        const type = a.mime.startsWith("image/") ? a.mime : `image/${extOf(a.name)}`;
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
        setView({ kind: "image", url });
      } else {
        const text = new TextDecoder().decode(bytes);
        setView({ kind: "text", text: text.slice(0, MAX_TEXT_CHARS), cut: text.length > MAX_TEXT_CHARS });
      }
      bytes.fill(0);
    }).catch((e) => { if (alive) setView({ kind: "error", message: vaultErrorMessage(e) }); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [path, a.id, a.mime, a.name, mode]);

  return (
    <Dialog title={a.name} icon={<AttachmentIcon name={a.name} mime={a.mime} size={14} />} size="lg" onClose={onClose}>
      <DialogBody detail={`${formatBytes(a.size)} · decrypted in memory only`}>
        {view.kind === "loading" && (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><Spinner /> Decrypting…</div>
        )}
        {view.kind === "error" && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">Couldn't open the file: {view.message}</p>
        )}
        {view.kind === "image" && (
          <img src={view.url} alt={a.name} className="block max-w-full max-h-[65vh] mx-auto rounded-md object-contain" />
        )}
        {view.kind === "text" && (
          <>
            <pre tabIndex={0} aria-label={`Contents of ${a.name}`}
                 className="max-h-[60vh] overflow-auto rounded-md p-3 text-xs font-mono whitespace-pre-wrap break-words bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
              {view.text}
            </pre>
            {view.cut && <p className="text-[11px] text-[var(--color-text-muted)]">Only the start of the file is shown. Use Save as for the whole file.</p>}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogButton variant="secondary" icon={<Download size={13} />} onClick={onSave}>Save as…</DialogButton>
        <DialogButton variant="primary" onClick={onClose}>Close</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
