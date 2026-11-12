import { isBackupPath } from "./vaultBackup";

/**
 * A backup file opened from outside (double-click in Explorer, "Open with Notiq", a second instance)
 * must open the restore dialog instead of a text tab. The open event can arrive before the React tree
 * has mounted, so the request is parked until the host component takes it.
 */

type Listener = (path: string) => void;

let pending: string | null = null;
const listeners = new Set<Listener>();

export function requestRestore(path: string): void {
  pending = path;
  listeners.forEach((l) => l(path));
}

/** The request made before anything was listening, if any (cleared). */
export function takePendingRestore(): string | null {
  const p = pending;
  pending = null;
  return p;
}

export function onRestoreRequest(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Routes a path the OS handed us. Returns true when it was a backup and the restore dialog was requested. */
export function routeOpenedPath(path: string): boolean {
  if (!isBackupPath(path)) return false;
  requestRestore(path);
  return true;
}
