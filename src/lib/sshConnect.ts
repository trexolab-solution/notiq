import { analyzeKey, type SshAuth } from "./sshEntry";

/** What the terminal needs to open an SSH session: the entry and the sign-in method to use. */
export interface SshTarget {
  /** Full vault path of the SSH entry; the backend reads the secrets itself. */
  path: string;
  auth: SshAuth;
  /** Tab title until the backend reports one. */
  title: string;
}

/** Which sign-in methods an SSH entry can actually use, key first. */
export function sshMethods(f: Record<string, string>): SshAuth[] {
  const out: SshAuth[] = [];
  const key = f.privateKey?.trim();
  if (key && analyzeKey(key).state !== "public") out.push("key");
  if (f.password?.trim()) out.push("password");
  return out;
}

/** `user@host` (or just the host) for a list row; empty when the entry has no host yet. */
export function sshLabel(f: Record<string, string>): string {
  const host = f.host?.trim();
  if (!host) return "";
  const user = f.username?.trim();
  const port = f.port?.trim();
  return `${user ? `${user}@` : ""}${host}${port && port !== "22" ? `:${port}` : ""}`;
}

/** An entry the terminal can sign in with: a host, a user name, and a private key or a password. */
export function isConnectable(f: Record<string, string>): boolean {
  return !!f.host?.trim() && !!f.username?.trim() && sshMethods(f).length > 0;
}
