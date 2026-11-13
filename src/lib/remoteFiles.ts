import { useAppStore } from "../store";
import { getFilesPlace, type FilesPlace } from "./vaultPrefs";
import { openRemoteFilesWindow } from "./remoteFilesWindow";
import type { SshTarget } from "./sshConnect";

/**
 * Where a saved server's remote file manager opens: a tab of the main window (the default) or a window of its own.
 * The choice is a setting (Settings → Vault → Servers); the sidebar menu also offers the other place for one open.
 */

/** Opens the file manager for `target` in `where` (default: the user's choice). */
export function openRemoteFiles(target: SshTarget, where?: FilesPlace): void {
  if ((where ?? getFilesPlace()) === "window") void openRemoteFilesWindow(target);
  else useAppStore.getState().openRemoteFiles(target);
}
