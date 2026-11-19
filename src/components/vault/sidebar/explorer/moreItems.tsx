import { ArrowDownAZ, CheckCheck, Clock, CloudDownload, Globe, History, Tags, TrendingUp } from "lucide-react";
import type { ContextMenuItem } from "../../../ui/ContextMenu";
import type { useSortMode } from "../prefs";

type SortMode = ReturnType<typeof useSortMode>[0];

const menuIcon = (el: JSX.Element) => <span className="inline-flex">{el}</span>;

/** Rare actions and view options: the header's "More actions" menu. */
export function explorerMoreItems(o: {
  sort: SortMode;
  setSort: (s: SortMode) => void;
  groupBySite: boolean;
  setGroupBySite: (v: boolean) => void;
  syncedCount: number;
  onManageTags: () => void;
  onRecentlySynced: () => void;
  onMarkAllSeen: () => void;
}): ContextMenuItem[] {
  const { sort, setSort, groupBySite, setGroupBySite, syncedCount } = o;
  return [
    { type: "label", label: "Sort by" },
    { type: "item", label: sort === "name" ? "Name  ✓" : "Name", icon: menuIcon(<ArrowDownAZ size={14} />), onClick: () => setSort("name") },
    { type: "item", label: sort === "modified" ? "Recently modified  ✓" : "Recently modified", icon: menuIcon(<Clock size={14} />),
      onClick: () => setSort("modified") },
    { type: "item", label: sort === "recent" ? "Recently used  ✓" : "Recently used", icon: menuIcon(<History size={14} />),
      onClick: () => setSort("recent") },
    { type: "item", label: sort === "used" ? "Most used  ✓" : "Most used", icon: menuIcon(<TrendingUp size={14} />),
      onClick: () => setSort("used") },
    { type: "separator" },
    { type: "item", label: "Manage tags…", icon: menuIcon(<Tags size={14} />), onClick: o.onManageTags },
    { type: "item", label: groupBySite ? "Group logins by website  ✓" : "Group logins by website", icon: menuIcon(<Globe size={14} />),
      onClick: () => setGroupBySite(!groupBySite) },
    { type: "separator" },
    { type: "item", label: `Recently synced (${syncedCount})`, icon: menuIcon(<CloudDownload size={14} />),
      onClick: o.onRecentlySynced },
    ...(syncedCount > 0
      ? [{ type: "item", label: "Mark all as seen", icon: menuIcon(<CheckCheck size={14} />), onClick: o.onMarkAllSeen } as ContextMenuItem]
      : []),
  ];
}
