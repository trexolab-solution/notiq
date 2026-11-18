import type { SshAuth } from "./sshEntry";

/**
 * Which sign-in method (private key or password) you used last for each saved server that has both, so the
 * choice dialog can put that one first. Per device, in local storage; never stored in the vault.
 */
const KEY = "pref:sshLastAuth";
const MAX = 200;

const norm = (path: string) => path.split("\\").join("/").toLowerCase();

function read(): Record<string, SshAuth> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, SshAuth> = {};
    for (const [k, v] of Object.entries(raw)) if (v === "key" || v === "password") out[k] = v;
    return out;
  } catch { return {}; }
}

/** The method last used for the server at `path`, or null. */
export function getLastSshAuth(path: string | undefined): SshAuth | null {
  return path ? read()[norm(path)] ?? null : null;
}

/** Remembers `auth` as the method last used for the server at `path`. */
export function setLastSshAuth(path: string | undefined, auth: SshAuth): void {
  if (!path) return;
  try {
    const all = read();
    delete all[norm(path)]; // re-insert last, so the oldest entries are the ones trimmed
    all[norm(path)] = auth;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* storage unavailable */ }
}
