import { readDir } from "@tauri-apps/plugin-fs";
import { ensureVaultDir } from "./vaultDir";
import { vaultReadFile } from "./vault";
import { hostOf, LOGIN_EXT, parseLogin, totpCode, type LoginEntry } from "./loginEntry";

export interface LoginMatch { path: string; entry: LoginEntry }

/** `login.example.com` matches a login saved for `example.com`, never the reverse. */
export function hostMatches(pageHost: string, savedHost: string): boolean {
  const p = pageHost.toLowerCase();
  const s = savedHost.toLowerCase();
  return !!s && (p === s || p.endsWith(`.${s}`));
}

async function listVaultFiles(): Promise<string[]> {
  const root = (await ensureVaultDir()).replace(/\\/g, "/").replace(/\/+$/, "");
  const out: string[] = [];
  const walk = async (rel: string, depth: number) => {
    const entries = await readDir(rel ? `${root}/${rel}` : root);
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile && /\.nqv$/i.test(e.name)) out.push(`${root}/${r}`);
      else if (e.isDirectory && depth < 3 && !e.name.startsWith(".")) await walk(r, depth + 1);
    }
  };
  await walk("", 0);
  return out;
}

/** Saved logins whose site matches `pageHost`. Requires an unlocked vault. */
export async function findLogins(pageHost: string): Promise<LoginMatch[]> {
  const found: LoginMatch[] = [];
  for (const path of await listVaultFiles()) {
    try {
      const f = await vaultReadFile(path);
      if (f.ext !== LOGIN_EXT) continue;
      const entry = parseLogin(f.content);
      if (hostMatches(pageHost, hostOf(entry.url))) found.push({ path, entry });
    } catch { /* unreadable file: skip */ }
  }
  return found;
}

export async function credentialsFor(m: LoginMatch) {
  const code = m.entry.totp ? await totpCode(m.entry.totp) : null;
  return { username: m.entry.username, password: m.entry.password, title: m.entry.title, ...(code ? { code } : {}) };
}
