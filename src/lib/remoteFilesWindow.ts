import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { toast } from "./toast";
import type { SshTarget } from "./sshConnect";

/**
 * The remote file manager's own window: its label, page address and the parsing of that address back.
 * Kept apart from `remoteFiles.ts` so the small window never loads the main window's store.
 */

const PREFIX = "remote-files-";

/** Same server and sign-in → same window label, so a second request focuses the window instead of making another. */
export function filesWindowLabel(t: Pick<SshTarget, "path" | "auth">): string {
  let h = 5381;
  for (const c of `${t.path}\n${t.auth}`) h = ((h * 33) ^ c.codePointAt(0)!) >>> 0;
  return `${PREFIX}${h.toString(16)}`;
}

/** The page a file manager window loads. Only the entry's path and the sign-in method travel; the backend reads the secrets. */
export function filesWindowUrl(t: SshTarget): string {
  const q = new URLSearchParams({ path: t.path, auth: t.auth, title: t.title });
  return `index.html#/remote-files?${q.toString()}`;
}

/** The target a window URL's hash names, or null when it isn't a valid one. */
export function parseFilesHash(hash: string): SshTarget | null {
  if (!hash.startsWith("#/remote-files")) return null;
  const q = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  const path = q.get("path");
  const auth = q.get("auth");
  if (!path || (auth !== "key" && auth !== "password")) return null;
  return { path, auth, title: q.get("title") || "server" };
}

export async function openRemoteFilesWindow(t: SshTarget): Promise<void> {
  const label = filesWindowLabel(t);
  try {
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) { await existing.setFocus(); return; }
  } catch { /* stale reference: make a new window */ }
  try {
    const w = new WebviewWindow(label, {
      url: filesWindowUrl(t),
      title: `Files · ${t.title}`,
      width: 1040, height: 700, minWidth: 640, minHeight: 420,
      center: true, decorations: false, shadow: true, visible: true, resizable: true,
    });
    await w.once("tauri://error", () => toast.error("Couldn't open the file manager window"));
  } catch (e) {
    toast.error(`Couldn't open the file manager window: ${e instanceof Error ? e.message : String(e)}`);
  }
}

