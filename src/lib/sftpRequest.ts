import type { SshTarget } from "./sshConnect";

/**
 * "Open this saved server in the file manager" requests, from the SSH entry editor and the vault tree.
 * The host component mounts with the app shell, but a request is parked until it takes it anyway.
 */

type Listener = (target: SshTarget) => void;

let pending: SshTarget | null = null;
const listeners = new Set<Listener>();

export function requestRemoteFiles(target: SshTarget): void {
  pending = target;
  listeners.forEach((l) => l(target));
}

/** The request nobody has handled yet, if any (cleared). */
export function takePendingRemoteFiles(): SshTarget | null {
  const t = pending;
  pending = null;
  return t;
}

export function onRemoteFilesRequest(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
