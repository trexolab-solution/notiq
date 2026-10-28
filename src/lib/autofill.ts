import { ensureVaultDir } from "./vaultDir";
import { vaultList, vaultMkdir, vaultReadFile, vaultWriteFile, VAULT_CHANGED_EVENT } from "./vault";
import { childNames, joinRel, nameError, normRel, toFull, uniqueName } from "./vaultTree";
import { emptyLogin, hostOf, LOGIN_EXT, parseLogin, serializeLogin, totpCode, type LoginEntry } from "./loginEntry";

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

// ─── Saving a login captured in the browser ──────────────────────────────────

export interface SaveRequest { id: string; host: string; url: string; username: string; password: string; title: string }
export interface SavePlan { kind: "unchanged" | "update" | "create"; target?: LoginMatch }

/**
 * Decides what saving `req` should do given the logins already stored for the
 * site: same username (case-insensitive; empty only equals empty) with the same
 * password → nothing; different password → update; otherwise create.
 * `existing` is expected to be the host-matched list from `findLogins`.
 */
export function planSave(existing: LoginMatch[], req: { username: string; password: string }): SavePlan {
  const u = req.username.trim().toLowerCase();
  const same = existing.filter((m) => m.entry.username.trim().toLowerCase() === u);
  if (same.some((m) => m.entry.password === req.password)) return { kind: "unchanged" };
  if (same.length) return { kind: "update", target: same[0] };
  return { kind: "create" };
}

export const LOGINS_FOLDER = "Logins";

/** Entry name from a page title: invalid file-name characters removed, host as fallback. */
export function defaultLoginName(title: string, host: string): string {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80).trim();
  return clean || host;
}

/** Writes the login to the vault (create under Logins/, or replace only the password). */
export async function saveLogin(
  plan: SavePlan,
  req: { url: string; host: string; username: string; password: string; title: string },
  name?: string,
): Promise<"saved" | "updated"> {
  let status: "saved" | "updated";
  if (plan.kind === "update" && plan.target) {
    const f = await vaultReadFile(plan.target.path);
    const cur = parseLogin(f.content);
    await vaultWriteFile(plan.target.path, serializeLogin({ ...cur, password: req.password }), LOGIN_EXT);
    status = "updated";
  } else {
    const root = (await ensureVaultDir()).replace(/\\/g, "/").replace(/\/+$/, "");
    const items = await vaultList();
    if (!items.some((i) => i.dir && normRel(i.rel).toLowerCase() === LOGINS_FOLDER.toLowerCase())) {
      await vaultMkdir(toFull(root, LOGINS_FOLDER));
    }
    const base = name !== undefined && !nameError(name) ? name.trim() : defaultLoginName(req.title, req.host);
    const unique = uniqueName(base, childNames(items, LOGINS_FOLDER));
    let origin = req.url;
    try { origin = new URL(req.url).origin; } catch { /* keep as given */ }
    await vaultWriteFile(
      toFull(root, joinRel(LOGINS_FOLDER, `${unique}.nqv`)),
      serializeLogin({ ...emptyLogin(unique), url: origin, username: req.username, password: req.password }),
      LOGIN_EXT,
    );
    status = "saved";
  }
  window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
  // Lazy import keeps this module (and its pure helpers) testable without the app store.
  const { useAppStore } = await import("../store");
  await useAppStore.getState().refreshVaultTabs();
  return status;
}
