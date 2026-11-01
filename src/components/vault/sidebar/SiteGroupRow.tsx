import { memo, useCallback, type MouseEvent } from "react";
import { useDroppable } from "@dnd-kit/core";
import { ChevronRight, Globe } from "lucide-react";
import type { SiteGroup } from "../../../lib/vaultSites";
import { INDENT, rowDomId, type DropData } from "./VaultRow";

interface Props {
  rowKey: string;
  group: SiteGroup;
  depth: number;
  expanded: boolean;
  selected: boolean;
  onToggle: (rel: string) => void;
  onSelect: (key: string, group: SiteGroup, e: MouseEvent) => void;
  onMenu: (key: string, x: number, y: number) => void;
  setRef: (key: string, el: HTMLDivElement | null) => void;
}

/**
 * Virtual row gathering the logins of one site: chevron, globe, domain and a count. It is not an
 * entry — it can't be renamed, trashed or dragged — but dropping an entry on it moves that entry
 * into the group's folder, like dropping on any row of that folder.
 */
export const SiteGroupRow = memo(function SiteGroupRow({ rowKey, group, depth, expanded, selected, onToggle, onSelect, onMenu, setRef }: Props) {
  const drop = useDroppable({ id: `drop:${rowKey}`, data: { folder: group.folder } satisfies DropData });
  const ref = useCallback((el: HTMLDivElement | null) => {
    drop.setNodeRef(el);
    setRef(rowKey, el);
  }, [drop.setNodeRef, setRef, rowKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={ref}
      id={rowDomId(rowKey)}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expanded}
      aria-selected={selected}
      aria-label={`${group.domain}, ${group.members.length} logins`}
      tabIndex={selected ? 0 : -1}
      title={`${group.domain}\n${group.members.length} logins for this website`}
      className={`vt-row${selected ? " is-selected" : ""}`}
      style={{ paddingLeft: 4 + depth * INDENT }}
      onClick={(e) => onSelect(rowKey, group, e)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu(rowKey, e.clientX, e.clientY); }}
    >
      <span className={`vt-row-chevron${expanded ? " is-open" : ""}`} onClick={(e) => { e.stopPropagation(); onToggle(group.rel); }} aria-hidden>
        <ChevronRight size={12} strokeWidth={2.2} />
      </span>
      <Globe size={14} className="vt-row-icon k-login" strokeWidth={1.9} aria-hidden />
      <span className="vt-row-name">{group.domain}</span>
      <span className="vt-count">{group.members.length}</span>
    </div>
  );
});
