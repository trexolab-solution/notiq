import { memo, useCallback, type MouseEvent, type ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Check, ChevronRight, Ellipsis, FolderOpen, Lock, SquareArrowOutUpRight, SquareTerminal, Star, UserRound } from "lucide-react";
import type { TreeNode } from "../../../lib/vaultTree";
import { isTextFieldTarget } from "../../../lib/contextMenu/target";
import { Tooltip } from "../../ui/Tooltip";
import { EntryIcon, kindLabel } from "./EntryIcon";
import type { LoginField } from "./copyLogin";

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
  /** Muted text after the name (a login's username, or the site a search matched). */
  subtitle?: string;
  /** Replaces the name with an inline editor. */
  editor?: ReactNode;
  /** New things are created in this folder (the selected entry's folder) — a softer highlight. */
  isTarget?: boolean;
  /** A sync brought this entry in from Drive: the dot's label ("Updated from Drive · from LAPTOP · 2 hours ago"). */
  syncMark?: string;
  /** A collapsed folder holding entries a sync brought in: the hollow dot's label. */
  syncMarkInside?: string;
  /** Ticked for a bulk action (Move, Star, Trash…). */
  checked?: boolean;
  /** Some row is ticked: a click on any row ticks it instead of opening it, and every tick box shows. */
  selecting?: boolean;
  /** The tick box was clicked (Shift extends the tick from the last ticked row to this one). */
  onCheck?: (key: string, node: TreeNode, e: MouseEvent) => void;
  /** Logins only: copy the username or password without opening the entry (hover buttons). */
  onCopyLogin?: (key: string, node: TreeNode, field: LoginField) => void;
  /** Click (Ctrl/Cmd+click and middle-click included — the handler reads the event). */
  onSelect: (key: string, node: TreeNode, e: MouseEvent) => void;
  /** Open an entry in a new permanent tab (double-click, hover button). */
  onOpenNew: (key: string, node: TreeNode) => void;
  /** SSH entries only: open the server in the built-in terminal (hover button). */
  onOpenTerminal?: (key: string, node: TreeNode) => void;
  /** SSH entries only: open the server's files in the remote file manager (hover button). */
  onOpenFiles?: (key: string, node: TreeNode) => void;
  onToggle: (rel: string) => void;
  onMenu: (key: string, node: TreeNode, x: number, y: number) => void;
  setRef: (key: string, el: HTMLDivElement | null) => void;
}

/** One file-tree row: chevron, type icon, name, compact tags, star and a "more" button. */
export const VaultRow = memo(function VaultRow({
  rowKey, node, depth, expanded, selected, isOpen, isDrop, dropFolder, showPath, subtitle, editor, isTarget,
  checked, selecting, onCheck, onCopyLogin, syncMark, syncMarkInside, onSelect, onOpenNew, onOpenTerminal, onOpenFiles, onToggle, onMenu, setRef,
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
  const markLabel = syncMark ?? syncMarkInside;

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
      aria-selected={checked || selected}
      aria-label={`${node.name}, ${kindLabel(node.kind)}${node.starred ? ", starred" : ""}${markLabel ? `, ${markLabel}` : ""}`}
      tabIndex={selected ? 0 : -1}
      className={`vt-row${selected ? " is-selected" : ""}${isTarget ? " is-target" : ""}${checked ? " is-checked" : ""}${selecting ? " is-selecting" : ""}${isOpen ? " is-open" : ""}${isDrop ? " is-drop" : ""}${drag.isDragging ? " is-dragging" : ""}`}
      style={{ paddingLeft: 4 + depth * INDENT }}
      onPointerDown={editor ? undefined : pointerDown}
      onClick={(e) => onSelect(rowKey, node, e)}
      // Middle-click opens an entry in a new tab (and must not start the browser's autoscroll).
      onMouseDown={(e) => { if (e.button === 1 && !node.dir) e.preventDefault(); }}
      onAuxClick={(e) => { if (e.button === 1 && !node.dir && !editor) { e.preventDefault(); onSelect(rowKey, node, e); } }}
      onDoubleClick={(e) => {
        if (node.dir || editor || isTextFieldTarget(e.target)) return;
        onOpenNew(rowKey, node);
      }}
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
      <span className="vt-lead">
        <EntryIcon kind={node.kind} open={node.dir && expanded} />
        {onCheck && !editor && (
          <button
            type="button"
            tabIndex={-1}
            className={`vt-check${checked ? " is-on" : ""}`}
            role="checkbox"
            aria-checked={!!checked}
            aria-label={`Select ${node.name}`}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onCheck(rowKey, node, e); }}
          >
            {checked && <Check size={11} strokeWidth={3} />}
          </button>
        )}
      </span>
      {editor ?? (
        <>
          <span className="vt-row-name">
            {node.name}
            {where && <span className="text-[11px] text-[var(--color-text-muted)]"> · {where}</span>}
            {subtitle && <span className="vt-row-sub">{subtitle}</span>}
          </span>
          {markLabel && (
            <span
              className={`vt-sync-dot${syncMark ? "" : " is-inside"}`}
              data-sync-mark={syncMark ? "entry" : "inside"}
              aria-hidden
            />
          )}
          {shownTags.length > 0 && (
            <span className="vt-row-tags" aria-hidden>
              {shownTags.map((t) => <span key={t} className="vt-row-tag">{t}</span>)}
              {extraTags > 0 && <span className="vt-row-tag">+{extraTags}</span>}
            </span>
          )}
          {node.starred && !showPath && <Star size={11} className="vt-row-star" fill="currentColor" aria-hidden />}
          {node.kind === "login" && onCopyLogin && !selecting && (
            <>
              <Tooltip content="Copy username">
                <button
                  type="button"
                  className="vt-icon-btn vt-row-more"
                  tabIndex={-1}
                  aria-label={`Copy username of ${node.name}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onCopyLogin(rowKey, node, "username"); }}
                >
                  <UserRound size={12} />
                </button>
              </Tooltip>
              <Tooltip content="Copy password" shortcut="Ctrl+Shift+C">
                <button
                  type="button"
                  className="vt-icon-btn vt-row-more"
                  tabIndex={-1}
                  aria-label={`Copy password of ${node.name}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onCopyLogin(rowKey, node, "password"); }}
                >
                  <Lock size={12} />
                </button>
              </Tooltip>
            </>
          )}
          {node.kind === "ssh" && onOpenTerminal && (
            <Tooltip content="Open in terminal">
              <button
                type="button"
                className="vt-icon-btn vt-row-more"
                tabIndex={-1}
                aria-label={`Open ${node.name} in terminal`}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onOpenTerminal(rowKey, node); }}
              >
                <SquareTerminal size={12} />
              </button>
            </Tooltip>
          )}
          {node.kind === "ssh" && onOpenFiles && (
            <Tooltip content="Open file manager">
              <button
                type="button"
                className="vt-icon-btn vt-row-more"
                tabIndex={-1}
                aria-label={`Open files on ${node.name}`}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onOpenFiles(rowKey, node); }}
              >
                <FolderOpen size={12} />
              </button>
            </Tooltip>
          )}
          {!node.dir && (
            <Tooltip content="Open in new tab" shortcut="Ctrl+Click">
              <button
                type="button"
                className="vt-icon-btn vt-row-more"
                tabIndex={-1}
                aria-label={`Open ${node.name} in new tab`}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onOpenNew(rowKey, node); }}
              >
                <SquareArrowOutUpRight size={12} />
              </button>
            </Tooltip>
          )}
          <button
            type="button"
            className="vt-icon-btn vt-row-more"
            tabIndex={-1}
            aria-label={`More actions for ${node.name}`}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
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
