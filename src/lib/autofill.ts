import { ensureVaultDir } from "./vaultDir";
import { vaultList, vaultReadFile } from "./vault";
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
  return (await vaultList()).filter((i) => !i.dir && /\.nqv$/i.test(i.rel)).map((i) => `${root}/${i.rel}`);
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
