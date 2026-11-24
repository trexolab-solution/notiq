import { useEffect, useRef, useState } from "react";
import { Check, Copy, File, FileSymlink, Files, Folder, FolderSymlink, Loader2 } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { formatBytes } from "../../lib/vaultBackup";
import {
  modeOctal, modeString, onSftpProgress, sftpCancel, sftpErrorMessage, sftpProps, sftpTally, SFTP_CANCELLED,
  type RemoteEntry, type RemoteProps, type RemoteTally,
} from "../../lib/sftp";
import { newTransferId } from "./panel/types";

/** One item the dialog describes: its full path, and its listing row when it has one (the open folder itself has none). */
export interface PropsItem { path: string; entry?: RemoteEntry }

const when = (t: number | null) => (t == null ? "Unknown" : new Date(t * 1000).toLocaleString(undefined, { dateStyle: "long", timeStyle: "medium" }));
const exact = (n: number) => `${formatBytes(n)} (${n.toLocaleString()} byte${n === 1 ? "" : "s"})`;
const parentOf = (p: string) => (p.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/");
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function owner(name: string | null, id: number | null): string {
  if (name && id != null) return `${name} (${id})`;
  return name ?? (id != null ? String(id) : "Unknown");
}

/** Type in words: "Folder", "Symbolic link to a folder", "PNG file"... */
function typeOf(p: RemoteProps): string {
  const what = p.kind === "dir" ? "folder" : p.kind === "file" ? "file" : "special file";
  if (p.link) return `Symbolic link to a ${what}`;
  if (p.kind === "file") {
    const base = p.path.split("/").pop() ?? "";
    const i = base.lastIndexOf(".");
    return i > 0 && i < base.length - 1 ? `${base.slice(i + 1).toUpperCase()} file` : "File";
  }
  return p.kind === "dir" ? "Folder" : "Special file";
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 py-1.5 text-[13px] border-b border-[var(--color-border)]/60 last:border-b-0">
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </div>
  );
}

/**
 * Properties of the selected files and folders, like a desktop file manager's: type, location, size (a folder's is
 * counted while the dialog is open, with a Stop), times, permissions and owner. One item shows its details; several
 * show what they hold together.
 */
export function PropertiesDialog({ sid, items, onPermissions, onClose }: {
  sid: number;
  items: PropsItem[];
  /** Offered for a single item: close this dialog and open the permissions editor. */
  onPermissions?: (entry: RemoteEntry) => void;
  onClose: () => void;
}) {
  const [details, setDetails] = useState<RemoteProps[] | null>(null);
  const [failure, setFailure] = useState("");
  const [tally, setTally] = useState<RemoteTally | null>(null);
  const [counting, setCounting] = useState(false);
  const [live, setLive] = useState<{ items: number; bytes: number } | null>(null);
  const transfer = useRef(0);
  const { copied, copy } = useCopyToClipboard();
  const paths = items.map((i) => i.path);
  const key = paths.join("\n");

  useEffect(() => {
    let dead = false;
    setDetails(null); setFailure(""); setTally(null); setLive(null);
    sftpProps(sid, paths).then((d) => {
      if (dead) return;
      setDetails(d);
      if (d.length === 1 && d[0].kind !== "dir") return; // a single file has its size already
      const t = newTransferId();
      transfer.current = t;
      setCounting(true);
      sftpTally(sid, t, paths).then((r) => { if (!dead) setTally(r); })
        .catch((e) => { if (!dead && sftpErrorMessage(e) !== SFTP_CANCELLED) setFailure(sftpErrorMessage(e)); })
        .finally(() => { if (!dead) setCounting(false); });
    }).catch((e) => { if (!dead) setFailure(sftpErrorMessage(e)); });
    return () => { dead = true; if (transfer.current) void sftpCancel(transfer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, key]);

  // The running count while a folder is being measured.
  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    void onSftpProgress((p) => { if (p.transfer === transfer.current) setLive({ items: p.done, bytes: p.total }); })
      .then((u) => { if (dead) u(); else off = u; });
    return () => { dead = true; off?.(); };
  }, []);

  const stop = () => { if (transfer.current) void sftpCancel(transfer.current); };
  const one = details && details.length === 1 ? details[0] : null;
  const entry = items.length === 1 ? items[0].entry : undefined;

  const containsText = () => {
    const n = tally ?? (live ? { files: live.items, folders: 0, bytes: live.bytes, unreadable: 0 } : null);
    if (!n) return counting ? "Counting…" : "";
    const parts = [plural(n.files, "file")];
    if (tally || n.folders) parts.push(plural(n.folders, "folder"));
    return parts.join(", ") + (tally && tally.unreadable ? ` (${plural(tally.unreadable, "place")} couldn't be read)` : "");
  };
  const total = tally ? tally.bytes : live?.bytes ?? null;

  const header = one
    ? { icon: one.kind === "dir" ? (one.link ? <FolderSymlink size={22} /> : <Folder size={22} />) : one.link ? <FileSymlink size={22} /> : <File size={22} />,
        title: one.path.split("/").pop() || one.path }
    : { icon: <Files size={22} />, title: `${items.length} items` };

  return (
    <Dialog title="Properties" size="md" onClose={onClose} zClassName="z-[60]">
      <DialogBody>
        <div className="flex items-center gap-3 pb-3 mb-1 border-b border-[var(--color-border)]">
          <span className="text-[var(--color-primary)] shrink-0" aria-hidden>{header.icon}</span>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate" title={header.title}>{header.title}</div>
            <div className="text-xs text-[var(--color-text-muted)]">{one ? typeOf(one) : details ? summary(details) : ""}</div>
          </div>
        </div>
        {failure && <p role="alert" className="text-sm text-[var(--color-danger)]">{failure}</p>}
        {!details && !failure && <p className="flex items-center gap-2 py-4 text-sm text-[var(--color-text-muted)]"><Loader2 size={14} className="animate-spin" aria-hidden /> Reading the details…</p>}
        {details && (
          <dl className="m-0">
            {one ? (
              <>
                <Row label="Type">{typeOf(one)}</Row>
                {one.link && one.target && <Row label="Points to"><code className="text-xs">{one.target}</code></Row>}
                <Row label="Location"><code className="text-xs">{parentOf(one.path)}</code></Row>
                <Row label="Full path">
                  <span className="flex items-start gap-1.5">
                    <code className="text-xs min-w-0 break-all">{one.path}</code>
                    <button type="button" className="shrink-0 mt-px text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer" aria-label="Copy path" title="Copy path" onClick={() => void copy(one.path)}>
                      {copied ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </span>
                </Row>
              </>
            ) : (
              <>
                <Row label="Location"><code className="text-xs">{commonParent(paths)}</code></Row>
                <Row label="Items">{summary(details)}</Row>
              </>
            )}
            {one && one.kind !== "dir" ? (
              <Row label="Size">{exact(one.size)}</Row>
            ) : (
              <>
                <Row label="Size">
                  {total != null ? exact(total) : counting ? "Counting…" : "—"}
                  {counting && (
                    <>
                      <Loader2 size={12} className="inline ml-2 animate-spin text-[var(--color-text-muted)]" aria-hidden />
                      <button type="button" className="ml-2 text-xs underline text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer" onClick={stop}>Stop</button>
                    </>
                  )}
                </Row>
                <Row label="Contains">{containsText()}</Row>
              </>
            )}
            {one && (
              <>
                <Row label="Modified">{when(one.mtime)}</Row>
                <Row label="Accessed">{when(one.atime)}</Row>
                <Row label="Permissions">
                  <span className="flex items-center gap-2 flex-wrap">
                    <code className="text-xs">{one.mode == null ? "Unknown" : `${modeString(one.mode)}  (${modeOctal(one.mode)})`}</code>
                    {entry && !one.link && onPermissions && (
                      <button type="button" className="text-xs underline text-[var(--color-primary)] cursor-pointer" onClick={() => onPermissions(entry)}>Change…</button>
                    )}
                  </span>
                </Row>
                <Row label="Owner">{owner(one.user, one.uid)}</Row>
                <Row label="Group">{owner(one.group, one.gid)}</Row>
              </>
            )}
          </dl>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogButton variant="primary" onClick={onClose}>Close</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}

/** "3 files, 2 folders" for what a selection is made of. */
function summary(d: RemoteProps[]): string {
  const dirs = d.filter((p) => p.kind === "dir").length;
  const rest = d.length - dirs;
  return [rest ? plural(rest, "file") : "", dirs ? plural(dirs, "folder") : ""].filter(Boolean).join(", ");
}

/** The folder every path lives in, or "Several locations". */
function commonParent(paths: string[]): string {
  const parents = new Set(paths.map(parentOf));
  return parents.size === 1 ? [...parents][0] : "Several locations";
}
