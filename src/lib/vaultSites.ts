import { hostOf, loginUrls, type LoginEntry } from "./loginEntry";
import { registrableDomain } from "./publicSuffix";
import { joinRel, type FlatRow, type TreeNode } from "./vaultTree";

/**
 * Pure helpers for the vault sidebar's website features: which site a login belongs to, searching
 * by site, and grouping logins of one site under a virtual row. No React, no Tauri. Never holds a
 * password — only hosts and the username (see `siteInfoOf`).
 */

/** What the sidebar knows about a login besides its name. Derived from the decrypted entry, kept in memory only. */
export interface LoginSite {
  /** Registrable domain of the main URL (or the host itself for IPs / localhost); null when there is no URL. */
  domain: string | null;
  /** Lower-cased hosts of the main URL and every other site. */
  hosts: string[];
  username: string;
}

/** Group key for a host: its registrable domain, else the host (IP address, localhost, intranet name). */
export function siteDomain(url: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  return registrableDomain(host) ?? host;
}

/** Sidebar-safe summary of a login entry: no password, TOTP secret, notes or custom fields. */
export function siteInfoOf(e: Pick<LoginEntry, "url" | "urls" | "username">): LoginSite {
  const hosts: string[] = [];
  for (const u of loginUrls(e)) { const h = hostOf(u); if (h && !hosts.includes(h)) hosts.push(h); }
  return { domain: siteDomain(e.url), hosts, username: e.username.trim() };
}

/**
 * Extra search text for an item: its sites and username (lower-case). Empty for anything that is not
 * a login with known info. Used as `Filter.extra`.
 */
export function searchTextOf(site: LoginSite | undefined): string[] {
  if (!site) return [];
  const out = [...site.hosts];
  if (site.domain && !out.includes(site.domain)) out.push(site.domain);
  if (site.username) out.push(site.username.toLowerCase());
  return out;
}

/** Why a login matched `query` when its name and tags did not: the matching site, or the username. */
export function siteMatchReason(site: LoginSite | undefined, query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!site || !q) return null;
  const host = site.hosts.find((h) => h.includes(q)) ?? (site.domain && site.domain.includes(q) ? site.domain : null);
  if (host) return host;
  return site.username.toLowerCase().includes(q) ? site.username : null;
}

// ── grouping ─────────────────────────────────────────────────────────────────

/** Logins of one site inside one folder, shown under a single collapsible virtual row. */
export interface SiteGroup {
  /** Virtual path `<folder>/@site:<domain>` — unique, never a real entry (names can't contain ":"). Doubles as the expanded-state key. */
  rel: string;
  folder: string;
  domain: string;
  members: TreeNode[];
}

/** A group header in the flattened list. */
export interface GroupRow { group: SiteGroup; depth: number }
/** A real entry; `inGroup` is the group's rel when it is listed under one. */
export interface EntryRow extends FlatRow { inGroup?: string }
export type ListRow = EntryRow | GroupRow;
export const isGroupRow = (r: ListRow): r is GroupRow => "group" in r;

/** Logins that share a site must be at least this many to be grouped. */
export const MIN_GROUP_SIZE = 2;

export type Slot = { node: TreeNode } | { group: SiteGroup };

/**
 * Groups the logins of one folder level by site. A group appears where its first member would
 * have, so the existing sort order is kept. Folders, other entry types, logins without a URL and
 * lone logins stay as normal rows.
 */
export function groupSiblings(
  nodes: TreeNode[],
  folder: string,
  siteOf: (n: TreeNode) => string | null,
  minSize = MIN_GROUP_SIZE,
): Slot[] {
  const byDomain = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    if (n.dir || n.kind !== "login") continue;
    const d = siteOf(n);
    if (!d) continue;
    const list = byDomain.get(d);
    if (list) list.push(n); else byDomain.set(d, [n]);
  }
  const out: Slot[] = [];
  const placed = new Set<string>();
  for (const n of nodes) {
    const d = !n.dir && n.kind === "login" ? siteOf(n) : null;
    const members = d ? byDomain.get(d) : undefined;
    if (!d || !members || members.length < minSize) { out.push({ node: n }); continue; }
    if (placed.has(d)) continue;
    placed.add(d);
    out.push({ group: { rel: joinRel(folder, `@site:${d}`), folder, domain: d, members } });
  }
  return out;
}

/**
 * Like `flattenTree`, but with same-site logins gathered under a group row. `isExpanded` is asked
 * about folder rels and group rels alike. With `siteOf` null nothing is grouped.
 */
export function flattenGrouped(
  nodes: TreeNode[],
  isExpanded: (rel: string) => boolean,
  siteOf: ((n: TreeNode) => string | null) | null,
): ListRow[] {
  const out: ListRow[] = [];
  const walk = (list: TreeNode[], folder: string, depth: number) => {
    const slots: Slot[] = siteOf ? groupSiblings(list, folder, siteOf) : list.map((node) => ({ node }));
    for (const s of slots) {
      if ("group" in s) {
        out.push({ group: s.group, depth });
        if (isExpanded(s.group.rel)) for (const m of s.group.members) out.push({ node: m, depth: depth + 1, inGroup: s.group.rel });
      } else {
        out.push({ node: s.node, depth });
        if (s.node.dir && isExpanded(s.node.rel)) walk(s.node.children, s.node.rel, depth + 1);
      }
    }
  };
  walk(nodes, "", 0);
  return out;
}
