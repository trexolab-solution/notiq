import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Remote file manager: wrappers over the backend's `sftp_*` commands (sftp_client.rs) and the pure helpers around them. */

export interface RemoteEntry {
  name: string;
  /** What it is; a link shows what it points at. */
  kind: "dir" | "file" | "other";
  link: boolean;
  size: number;
  /** Seconds since 1970. */
  mtime: number | null;
  /** Permission bits only (e.g. 0o755). */
  mode: number | null;
}

export interface RemoteListing { path: string; entries: RemoteEntry[] }
export interface OpenedSftp { title: string; home: string }

/** What a transfer command says when the user stopped it, or when the target already exists. */
export const SFTP_CANCELLED = "cancelled";
export const SFTP_EXISTS = "already_exists";
/** What reading a file for the viewer says when it is over the limit; what saving says when the file changed on the server. */
export const SFTP_TOO_BIG = "too_big";
export const SFTP_CHANGED = "changed";
/** What moving an item to the Trash says when the server can't (another disk, no permission). */
export const SFTP_TRASH_FAILED = "trash_failed";
/** What a folder transfer says when the destination folder is already there (then `merge` says how to go on). */
export const SFTP_EXISTS_DIR = "already_exists_folder";

/** True when a backend message says the connection to the server is gone (as opposed to a failed action on a live one). */
export function isConnectionError(message: string): boolean {
  return /connection|disconnect|\bclosed\b|broken pipe|\beof\b|reset by|timed out|timeout/i.test(message);
}

export const sftpOpen = (id: number, path: string, auth: string) => invoke<OpenedSftp>("sftp_open", { id, path, auth });
export const sftpClose = (id: number) => invoke<void>("sftp_close", { id });
export const sftpList = (id: number, path: string) => invoke<RemoteListing>("sftp_list", { id, path });
export const sftpMkdir = (id: number, path: string) => invoke<void>("sftp_mkdir", { id, path });
export const sftpRename = (id: number, from: string, to: string) => invoke<void>("sftp_rename", { id, from, to });
export const sftpChmod = (id: number, path: string, mode: number) => invoke<void>("sftp_chmod", { id, path, mode });
export const sftpRemove = (id: number, path: string) => invoke<void>("sftp_remove", { id, path });
/** Everything the Properties dialog shows about one item. */
export interface RemoteProps {
  path: string;
  kind: "dir" | "file" | "other";
  link: boolean;
  target: string | null;
  size: number;
  mtime: number | null;
  atime: number | null;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  user: string | null;
  group: string | null;
}
/** What lies under some folders and files (links are counted, not followed). */
export interface RemoteTally { files: number; folders: number; bytes: number; unreadable: number }
export const sftpProps = (id: number, paths: string[]) => invoke<RemoteProps[]>("sftp_props", { id, paths });
/** Counts what lies under the paths; cancel with `sftpCancel(transferId)`. Progress arrives as `sftp-progress` (`done` = items, `total` = bytes). */
export const sftpTally = (id: number, transferId: number, paths: string[]) => invoke<RemoteTally>("sftp_tally", { id, transferId, paths });
/** Which archive tools the server has (Compress and Extract run them over SSH). */
export interface ArchiveTools { zip: boolean; unzip: boolean; tar: boolean }
export type ArchiveFormat = "zip" | "tar.gz";
export const sftpArchiveTools = (id: number) => invoke<ArchiveTools>("sftp_archive_tools", { id });
/** Compresses items of `dir` into `outName` there; resolves to the archive's path. Rejects with `already_exists` unless `overwrite`. */
export const sftpCompress = (id: number, transferId: number, dir: string, names: string[], outName: string, format: ArchiveFormat, overwrite: boolean) =>
  invoke<string>("sftp_compress", { id, transferId, dir, names, outName, format, overwrite });
/** Extracts an archive into `dest`. `merge` keeps (`skip`) or replaces files already there; none rejects with `already_exists_folder` when `dest` exists. */
export const sftpExtract = (id: number, transferId: number, archive: string, dest: string, merge?: MergeMode) =>
  invoke<void>("sftp_extract", { id, transferId, archive, dest, merge: merge ?? null });

/** Whether a file name ends like an archive the server can extract (zip, tar, tar.gz, tgz, tar.bz2, tar.xz). */
export const isArchiveName = (name: string) => /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i.test(name);
/** The archive's kind, for choosing the tool: zip needs `unzip`, everything else `tar`. */
export const archiveNeeds = (name: string): "unzip" | "tar" => (/\.zip$/i.test(name) ? "unzip" : "tar");
/** An archive's name without its archive extension ("site.tar.gz" -> "site"). */
export const archiveStem = (name: string) => name.replace(/\.(tar\.gz|tar\.bz2|tar\.xz|tgz|tbz2|txz|tar|zip)$/i, "");
/** The suggested name of a new archive: the item's own name for one item, else "Archive". */
export const defaultArchiveName = (names: string[], fmt: ArchiveFormat) => `${names.length === 1 ? names[0] : "Archive"}${fmt === "zip" ? ".zip" : ".tar.gz"}`;
/** The format a typed archive name asks for: ".tar.gz" / ".tgz" is tar, anything else zip (the extension is added when missing). */
export function archiveTarget(typed: string): { name: string; format: ArchiveFormat } {
  const name = typed.trim();
  if (/\.(tar\.gz|tgz)$/i.test(name)) return { name, format: "tar.gz" };
  return { name: /\.zip$/i.test(name) ? name : `${name}.zip`, format: "zip" };
}
export const sftpCancel = (transfer: number) => invoke<void>("sftp_cancel", { transfer });
/** `merge` applies to a folder that already exists at the destination: keep (`skip`) or overwrite (`replace`) files with the same name. */
export type MergeMode = "skip" | "replace";
export const sftpDownload = (id: number, transferId: number, remote: string, local: string, overwrite: boolean, merge?: MergeMode) =>
  invoke<number>("sftp_download", { id, transferId, remote, local, overwrite, merge: merge ?? null });
export const sftpUpload = (id: number, transferId: number, local: string, remote: string, overwrite: boolean, merge?: MergeMode) =>
  invoke<number>("sftp_upload", { id, transferId, local, remote, overwrite, merge: merge ?? null });
/** What to do when something already has the target's name. Resolves to the path the item ended up at. */
export type MoveConflict = "fail" | "replace" | "keep_both";
export const sftpMove = (id: number, from: string, to: string, onConflict: MoveConflict, useTrash: boolean) =>
  invoke<string>("sftp_move", { id, from, to, onConflict, useTrash });

/** Full paths of the files copied in the system's file explorer (empty when there are none, or off Windows). */
export const clipboardFiles = () => invoke<string[]>("clipboard_files");

/** One item in the server's Trash (freedesktop layout under ~/.local/share/Trash). */
export interface TrashItem {
  /** Its name inside the Trash. */
  id: string;
  /** Where it was deleted from. */
  original: string;
  /** Seconds since 1970. */
  deleted: number | null;
  kind: "dir" | "file" | "other";
  size: number;
}
export const sftpTrash = (id: number, path: string) => invoke<void>("sftp_trash", { id, path });
export const sftpTrashList = (id: number) => invoke<TrashItem[]>("sftp_trash_list", { id });
export const sftpTrashRestore = (id: number, item: string) => invoke<void>("sftp_trash_restore", { id, item });
export const sftpTrashDelete = (id: number, item: string) => invoke<void>("sftp_trash_delete", { id, item });
export const sftpTrashEmpty = (id: number) => invoke<void>("sftp_trash_empty", { id });

export interface RemoteFileData { data: string; mtime: number | null }
export const sftpRead = (id: number, path: string, limit: number) => invoke<RemoteFileData>("sftp_read", { id, path, limit });
/** Saves `text` over the file; `expect` is the modified time it was opened with, `force` overwrites a file changed since. */
export const sftpWrite = (id: number, path: string, text: string, expect: number | null, force: boolean) =>
  invoke<number | null>("sftp_write", { id, path, text, expect, force });

export interface SftpProgress { transfer: number; done: number; total: number }
export const onSftpProgress = (fn: (p: SftpProgress) => void) => listen<SftpProgress>("sftp-progress", (e) => fn(e.payload));

/** Backend errors arrive as plain strings. */
export const sftpErrorMessage = (e: unknown): string => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

// ── remote paths (always `/`, whatever the local system is) ─────────────────────

export function joinRemote(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** The folder above `path`; the root stays the root. */
export function parentRemote(path: string): string {
  const t = path.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}

/** `/var/log/nginx` → `[{name:"/",path:"/"},{name:"var",path:"/var"},…]`, for the clickable path bar. */
export function crumbs(path: string): { name: string; path: string }[] {
  const out = [{ name: "/", path: "/" }];
  let acc = "";
  for (const part of path.split("/").filter(Boolean)) {
    acc += `/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

/** A name for a new file or folder: not empty, no slash, not `.` or `..`. Returns the problem, or null when it's fine. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n === "." || n === "..") return "A name can't be \".\" or \"..\".";
  if (n.includes("/")) return "A name can't contain a slash.";
  return null;
}

// ── showing entries ────────────────────────────────────────────────────────────

export type SortKey = "name" | "size" | "mtime";
export interface SortState { key: SortKey; desc: boolean }

/** Folders first (always), then by the chosen column; names break ties. */
export function sortEntries(entries: RemoteEntry[], sort: SortState): RemoteEntry[] {
  const sign = sort.desc ? -1 : 1;
  const byName = (a: RemoteEntry, b: RemoteEntry) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name);
  const value = (e: RemoteEntry) => (sort.key === "size" ? e.size : e.mtime ?? 0);
  return [...entries].sort((a, b) => {
    if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
    if (sort.key === "name") return sign * byName(a, b);
    return value(a) === value(b) ? byName(a, b) : sign * (value(a) - value(b));
  });
}

export function visibleEntries(entries: RemoteEntry[], filter: string, showHidden: boolean): RemoteEntry[] {
  const q = filter.trim().toLowerCase();
  return entries.filter((e) => (showHidden || !e.name.startsWith(".")) && (!q || e.name.toLowerCase().includes(q)));
}

/** `rwxr-xr-x` for 0o755. */
export function modeString(mode: number | null): string {
  if (mode == null) return "";
  const bits = "rwxrwxrwx";
  let out = "";
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits[i] : "-";
  return out;
}

/** Octal text of the permission bits, `755`. */
export const modeOctal = (mode: number | null): string => (mode == null ? "" : (mode & 0o777).toString(8).padStart(3, "0"));

/** Parses `755` / `0644` (octal digits only). */
export function parseOctalMode(text: string): number | null {
  const t = text.trim();
  if (!/^[0-7]{3,4}$/.test(t)) return null;
  return parseInt(t, 8);
}

export function formatModified(mtime: number | null, now = new Date()): string {
  if (mtime == null) return "";
  const d = new Date(mtime * 1000);
  const date = d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time}`;
}

/** 0–100 for a progress bar; an empty file is done. */
export const percent = (done: number, total: number): number => (total <= 0 ? 100 : Math.min(100, Math.floor((done / total) * 100)));

// ── the in-app viewer ───────────────────────────────────────────────────────────

/** Biggest image and biggest text file the viewer opens (bigger ones are downloaded instead). */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** A PDF is shown by the system's own viewer, so it may be as large as a picture. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** Whether a file is shown as a PDF. */
export const isPdf = (name: string): boolean => name.toLowerCase().endsWith(".pdf");

const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
};

/** The picture type for a file name, or null when it isn't an image the viewer can show. */
export function imageMime(name: string): string | null {
  const i = name.lastIndexOf(".");
  return i < 0 ? null : IMAGE_MIME[name.slice(i + 1).toLowerCase()] ?? null;
}

/** Bytes from the backend's base64. */
export function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The text in `bytes`, or null when they aren't text (a NUL byte, or not valid UTF-8). */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}
