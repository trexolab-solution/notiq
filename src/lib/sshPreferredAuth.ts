import type { SshAuth } from "./sshEntry";

/**
 * "When both are saved": for a server with a password and a private key, whether opening it asks which one to
 * use (the default) or always uses one. Per device, in local storage; never stored in the vault.
 */
export type AuthPreference = "ask" | SshAuth;

const KEY = "pref:sshPreferredAuth";
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

export function getAuthPreference(path: string | undefined): AuthPreference {
  return (path && read()[norm(path)]) || "ask";
}

export function setAuthPreference(path: string | undefined, pref: AuthPreference): void {
  if (!path) return;
  try {
    const all = read();
    delete all[norm(path)];
    if (pref !== "ask") all[norm(path)] = pref;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* storage unavailable */ }
}
