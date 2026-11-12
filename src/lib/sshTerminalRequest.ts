import type { SshTarget } from "./sshConnect";

/**
 * "Open this saved server in the terminal" requests, from anywhere in the app (the SSH entry editor).
 * The terminal panel may not be mounted yet (it mounts on first open), so a request is parked until the
 * panel takes it; once mounted, the panel listens and opens a tab straight away.
 */

type Listener = (target: SshTarget) => void;

let pending: SshTarget | null = null;
const listeners = new Set<Listener>();

export function requestSshSession(target: SshTarget): void {
  pending = target;
  listeners.forEach((l) => l(target));
}

/** The request nobody has handled yet, if any (cleared). */
export function takePendingSsh(): SshTarget | null {
  const t = pending;
  pending = null;
  return t;
}

export function onSshRequest(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
