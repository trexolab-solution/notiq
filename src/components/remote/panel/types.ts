import type { RemoteEntry } from "../../../lib/sftp";

// Session and transfer ids are shared by every window (the backend keeps them in one table), so each window starts
// from its own range: two file managers must never share an id.
const idBase = (Date.now() % 1_000_000) * 1000;
let nextSession = idBase + 1;
let nextTransfer = idBase + 1;

/** A fresh id for an SFTP session. */
export const newSessionId = () => nextSession++;
/** A fresh id for a transfer. */
export const newTransferId = () => nextTransfer++;

export type Phase = "connecting" | "ready" | "failed";
/** The answer to "this name is already taken": replace it, (for folders) keep the files that are already there, or stop. */
export type Conflict = "replace" | "skip-matching" | "cancel";
export type MoveChoice = { choice: "replace" | "keep_both" | "skip"; all: boolean };
export type Prompt = { kind: "folder" } | { kind: "file" } | { kind: "rename"; entry: RemoteEntry } | { kind: "perms"; entry: RemoteEntry }
  | { kind: "props"; items: { path: string; entry?: RemoteEntry }[] }
  | { kind: "compress"; items: RemoteEntry[] };
/** The connection to the server: fine, being re-established after it dropped, or lost for good (a button retries). */
export type Link = "ok" | "reconnecting" | "lost";
