import { useCallback, useMemo } from "react";
import { useAppStore } from "../../../../store";
import { useVaultStore } from "../../../../store/vaultStore";
import { isVaultPath, type VaultItem } from "../../../../lib/vault";
import {
  allFolders, buildTree, filterItems, isFiltering, matchesFilter, normRel, starredNodes, tagCounts, toRel, trashRoots,
  type TreeNode,
} from "../../../../lib/vaultTree";
import { flattenGrouped, isGroupRow, searchTextOf, siteMatchReason } from "../../../../lib/vaultSites";
import type { useSortMode } from "../prefs";
import type { useVaultUsage } from "../../../../lib/vaultUsage";
import { useLoginSites } from "../useLoginSites";

/**
 * What the explorer shows, derived from the vault items: the filtered, sorted tree as rows (grouped by site when
 * asked), the starred list, row subtitles, tags, folders, open entries and the Trash count.
 */
export function useExplorerTree({ root, items, trash, query, selTags, sort, usage, groupBySite, expanded }: {
  root: string;
  items: VaultItem[];
  trash: VaultItem[];
  query: string;
  selTags: string[];
  sort: ReturnType<typeof useSortMode>[0];
  usage: ReturnType<typeof useVaultUsage>;
  groupBySite: boolean;
  expanded: ReadonlySet<string>;
}) {
  // Open tabs, as a stable string so typing in an editor doesn't re-render the tree.
  const openPathsKey = useAppStore((s) =>
    s.tabs.filter((t) => isVaultPath(t.filePath)).map((t) => t.filePath).join("\n"));
  const openRels = useMemo(() => {
    const set = new Set<string>();
    for (const p of openPathsKey ? openPathsKey.split("\n") : []) {
      const r = root ? toRel(root, p) : null;
      if (r) set.add(r.toLowerCase());
    }
    return set;
  }, [openPathsKey, root]);

  // ── derived tree ───────────────────────────────────────────────────────────
  // Sites and usernames of logins (read while unlocked; hosts only, never passwords).
  const unlocked = useVaultStore((s) => s.unlocked);
  const sites = useLoginSites(root, items, unlocked);
  const siteExtra = useCallback((i: VaultItem) => searchTextOf(sites.get(normRel(i.rel).toLowerCase())), [sites]);
  const filter = useMemo(() => ({ query, tags: selTags, extra: siteExtra }), [query, selTags, siteExtra]);
  const filtering = isFiltering(filter);
  const filtered = useMemo(() => filterItems(items, filter), [items, filter]);
  const tree = useMemo(() => buildTree(filtered, sort, usage), [filtered, sort, usage]);
  // Searching shows everything open, groups included.
  const isExpanded = useCallback((rel: string) => filtering || expanded.has(rel), [filtering, expanded]);
  const siteOf = useMemo(
    () => (groupBySite ? (n: TreeNode) => sites.get(n.rel.toLowerCase())?.domain ?? null : null),
    [groupBySite, sites],
  );
  const rows = useMemo(() => flattenGrouped(tree, isExpanded, siteOf), [tree, isExpanded, siteOf]);
  // Muted text after a login: the username inside a site group; otherwise, when a search matched
  // only by site or username, what matched.
  const subtitles = useMemo(() => {
    const m = new Map<string, string>();
    const q = query.trim();
    for (const r of rows) {
      if (isGroupRow(r) || r.node.dir) continue;
      const key = r.node.rel.toLowerCase();
      const site = sites.get(key);
      if (r.inGroup) { if (site?.username) m.set(key, site.username); continue; }
      const byNameOrTag = r.node.name.toLowerCase().includes(q.toLowerCase())
        || r.node.tags.some((t) => t.toLowerCase().includes(q.toLowerCase()));
      const why = q && !byNameOrTag ? siteMatchReason(site, q) : null;
      if (why) m.set(key, why);
    }
    return m;
  }, [rows, sites, query]);
  const starred = useMemo(
    () => starredNodes(filtering ? items.filter((i) => matchesFilter(i, filter)) : items, sort, usage),
    [filtering, filter, items, sort, usage],
  );
  const tags = useMemo(() => tagCounts(items), [items]);
  const folders = useMemo(() => allFolders(items), [items]);
  const trashCount = useMemo(() => trashRoots(trash).length, [trash]);

  return { openRels, filtering, isExpanded, rows, subtitles, starred, tags, folders, trashCount };
}
