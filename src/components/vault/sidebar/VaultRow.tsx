import { memo, useCallback, type MouseEvent, type ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { ChevronRight, Ellipsis, Star } from "lucide-react";
import type { TreeNode } from "../../../lib/vaultTree";
import { isTextFieldTarget } from "../../../lib/contextMenu/target";
import { EntryIcon, kindLabel } from "./EntryIcon";

export const INDENT = 14;
export const rowDomId = (key: string) => `vt-row-${key.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.charCodeAt(0)}`)}`;

export interface DragData { rel: string; dir: boolean; name: string; kind: TreeNode["kind"] }
export interface DropData { folder: string }

interface Props {
  rowKey: string;
  node: TreeNode;
  depth: number;
  expanded: boolean;
  selected: boolean;
  /** An open editor tab shows this note. */
  isOpen: boolean;
  /** Highlight as the current drop target. */
  isDrop: boolean;
  /** Folder a drop on this row moves into (folder itself, a note's parent); null = not a drop target. */
  dropFolder: string | null;
  /** Show the full rel path as context (Starred group). */
  showPath?: boolean;
  /** Replaces the name with an inline editor. */
  editor?: ReactNode;
  onSelect: (key: string, node: TreeNode, e: MouseEvent) => void;
  onToggle: (rel: string) => void;
  onMenu: (key: string, node: TreeNode, x: number, y: number) => void;
  setRef: (key: string, el: HTMLDivElement | null) => void;
}

/** One file-tree row: chevron, type icon, name, compact tags, star and a "more" button. */
export const VaultRow = memo(function VaultRow({
  rowKey, node, depth, expanded, selected, isOpen, isDrop, dropFolder, showPath, editor,
  onSelect, onToggle, onMenu, setRef,
}: Props) {
  const drag = useDraggable({
    id: rowKey,
    data: { rel: node.rel, dir: node.dir, name: node.name, kind: node.kind } satisfies DragData,
    disabled: !!editor,
  });
  const drop = useDroppable({
    id: `drop:${rowKey}`,
    data: { folder: dropFolder ?? "" } satisfies DropData,
    disabled: dropFolder === null,
  });

  const ref = useCallback((el: HTMLDivElement | null) => {
    drag.setNodeRef(el);
    drop.setNodeRef(el);
    setRef(rowKey, el);
  }, [drag.setNodeRef, drop.setNodeRef, setRef, rowKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const shownTags = node.tags.slice(0, 2);
  const extraTags = node.tags.length - shownTags.length;
  const where = showPath && node.rel.includes("/") ? node.rel.slice(0, node.rel.lastIndexOf("/")) : "";
  const tooltip = [
    node.dir ? node.rel : node.rel.replace(/\.nqv$/i, ""),
    kindLabel(node.kind),
    node.tags.length ? `Tags: ${node.tags.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  // dnd-kit's listeners include a keyboard handler (Space/Enter starts a drag) — the
  // tree has its own keyboard model, so only forward the pointer listener.
  const pointerDown = drag.listeners?.onPointerDown as ((e: React.PointerEvent) => void) | undefined;

  return (
    <div
      ref={ref}
      id={rowDomId(rowKey)}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={node.dir ? expanded : undefined}
      aria-selected={selected}
      aria-label={`${node.name}, ${kindLabel(node.kind)}${node.starred ? ", starred" : ""}`}
      tabIndex={selected ? 0 : -1}
      title={editor ? undefined : tooltip}
      className={`vt-row${selected ? " is-selected" : ""}${isOpen ? " is-open" : ""}${isDrop ? " is-drop" : ""}${drag.isDragging ? " is-dragging" : ""}`}
      style={{ paddingLeft: 4 + depth * INDENT }}
      onPointerDown={editor ? undefined : pointerDown}
      onClick={(e) => onSelect(rowKey, node, e)}
      onContextMenu={(e) => {
        if (isTextFieldTarget(e.target)) return; // inline rename box: text menu instead
        e.preventDefault(); e.stopPropagation(); onMenu(rowKey, node, e.clientX, e.clientY);
      }}
    >
      {node.dir ? (
        <span
          className={`vt-row-chevron${expanded ? " is-open" : ""}`}
          onClick={(e) => { e.stopPropagation(); onToggle(node.rel); }}
          aria-hidden
        >
          <ChevronRight size={12} strokeWidth={2.2} />
        </span>
      ) : (
        <span className="vt-row-chevron" aria-hidden />
      )}
      <EntryIcon kind={node.kind} open={node.dir && expanded} />
      {editor ?? (
        <>
          <span className="vt-row-name">
            {node.name}
            {where && <span className="text-[11px] text-[var(--color-text-muted)]"> · {where}</span>}
          </span>
          {shownTags.length > 0 && (
            <span className="vt-row-tags" aria-hidden>
              {shownTags.map((t) => <span key={t} className="vt-row-tag">{t}</span>)}
              {extraTags > 0 && <span className="vt-row-tag">+{extraTags}</span>}
            </span>
          )}
          {node.starred && !showPath && <Star size={11} className="vt-row-star" fill="currentColor" aria-hidden />}
          <button
            type="button"
            className="vt-icon-btn vt-row-more"
            tabIndex={-1}
            aria-label={`More actions for ${node.name}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              onMenu(rowKey, node, r.right, r.bottom);
            }}
          >
            <Ellipsis size={14} />
          </button>
        </>
      )}
    </div>
  );
});
