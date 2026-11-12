import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  DndContext, DragOverlay, PointerSensor, pointerWithin, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { ChevronRight, Star } from "lucide-react";
import { canMoveTo, parentRel, type TreeNode } from "../../../lib/vaultTree";
import { isGroupRow, type ListRow, type SiteGroup } from "../../../lib/vaultSites";
import { isTextFieldTarget } from "../../../lib/contextMenu/target";
import { openModeFromEvent, type VaultOpenMode } from "../../../lib/vaultTabs";
import { EntryIcon } from "./EntryIcon";
import { INDENT, VaultRow, rowDomId, type DragData, type DropData } from "./VaultRow";
import { SiteGroupRow } from "./SiteGroupRow";
import { markedInside, markerLabel, type SyncMarker } from "../../../lib/syncMarkers";

/**
 * A visible, focusable row (Starred group rows and tree rows share one keyboard order). Either a real
 * entry (`node`) or a virtual site group (`group`); `inGroup` is the group's rel for entries listed under one.
 */
export interface VisibleRow { key: string; node: TreeNode | null; group?: SiteGroup; inGroup?: string; depth: number; starred: boolean }

export const treeKey = (rel: string) => `t:${rel}`;
export const starKey = (rel: string) => `s:${rel}`;
/** Key of a virtual site-group row (its rel is `<folder>/@site:<domain>`). */
export const groupKey = (rel: string) => `g:${rel}`;

interface Props {
  rows: ListRow[];
  starred: TreeNode[];
  /** Muted text per entry (lower-cased rel): a grouped login's username, or the site a search matched. */
  subtitles?: Map<string, string>;
  starredOpen: boolean;
  onStarredOpen: (open: boolean) => void;
  isExpanded: (rel: string) => boolean;
  selectedKey: string | null;
  /** Lower-cased rels of notes open in an editor tab. */
  openRels: Set<string>;
  editingKey: string | null;
  renderEditor: (node: TreeNode) => ReactNode;
  /** Inline "new folder / new entry" row, rendered as first child of `parent`. */
  creating: { parent: string; row: ReactNode } | null;
  /** Shown instead of rows (empty vault / no matches). */
  empty: ReactNode;
  /** Folder new things go into (resolved from the selection); its row gets a soft highlight. "" = root. */
  targetFolder?: string;
  /** null clears the selection (empty-space click, Escape) so new things go to the vault root. */
  onSelectKey: (key: string | null) => void;
  /** Folder: toggle. Entry: open in the preview tab, or in a new permanent tab for "permanent". */
  onActivate: (node: TreeNode, key: string, mode?: VaultOpenMode) => void;
  onToggle: (rel: string, open?: boolean) => void;
  onRename: (key: string, node: TreeNode) => void;
  onTrash: (node: TreeNode) => void;
  /** SSH entries: open the server in the built-in terminal. */
  onOpenTerminal?: (node: TreeNode) => void;
  onMenu: (key: string | null, node: TreeNode | null, x: number, y: number) => void;
  onMove: (rel: string, destFolder: string) => void;
  /** "Changed by sync" markers by lower-cased rel (dots on rows and collapsed folders). */
  marks?: Map<string, SyncMarker>;
}

/** The dot labels of a row: its own marker, or (collapsed folder) how many marked entries it holds. */
export function rowMarkLabels(marks: Map<string, SyncMarker> | undefined, node: TreeNode, open: boolean, now = Date.now()):
  { syncMark?: string; syncMarkInside?: string } {
  if (!marks?.size) return {};
  const own = marks.get(node.rel.toLowerCase());
  if (own) return { syncMark: markerLabel(own, now) };
  if (!node.dir || open) return {};
  const n = markedInside(marks, node.rel);
  return n ? { syncMarkInside: n === 1 ? "1 item changed by sync" : `${n} items changed by sync` } : {};
}

const ROOT_DROP_ID = "drop:root";

/** The event hit a row, a button or a text field — anything but the tree's empty space. */
export function isOnControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[role="treeitem"], button, input, textarea, a');
}

/** The keyboard-navigable, drag-and-drop file tree (plus the pinned Starred group). */
export function VaultTree(p: Props) {
  const { rows, starred, starredOpen, isExpanded, selectedKey, onSelectKey } = p;

  const visible: VisibleRow[] = useMemo(() => [
    ...(starredOpen ? starred.map((n) => ({ key: starKey(n.rel), node: n, depth: 0, starred: true })) : []),
    ...rows.map((r): VisibleRow => isGroupRow(r)
      ? { key: groupKey(r.group.rel), node: null, group: r.group, depth: r.depth, starred: false }
      : { key: treeKey(r.node.rel), node: r.node, inGroup: r.inGroup, depth: r.depth, starred: false }),
  ], [rows, starred, starredOpen]);

  // â”€â”€ focus management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const refs = useRef(new Map<string, HTMLDivElement>());
  const setRef = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) refs.current.set(key, el); else refs.current.delete(key);
  }, []);
  const focusPending = useRef(false);
  const selectAndFocus = (key: string) => { focusPending.current = true; onSelectKey(key); };
  useEffect(() => {
    if (!focusPending.current || !selectedKey) return;
    focusPending.current = false;
    const el = refs.current.get(selectedKey);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedKey, visible]);

  // Focusing the tree itself selects the first row only when it was tabbed into — not when the user
  // clicked empty space or pressed Escape to clear the selection (that's how you target the root).
  const treeRef = useRef<HTMLDivElement>(null);
  const skipFocusSelect = useRef(false);
  const clearSelection = () => {
    onSelectKey(null);
    skipFocusSelect.current = true;
    treeRef.current?.focus({ preventScroll: true });
    skipFocusSelect.current = false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Only rows (and the tree itself) drive navigation — not inputs or the section buttons.
    if (!(e.target as HTMLElement).matches('[role="treeitem"], [role="tree"]')) return;
    const idx = visible.findIndex((r) => r.key === selectedKey);
    const cur = idx >= 0 ? visible[idx] : null;
    if (e.key === "Escape" && selectedKey) {
      e.preventDefault(); e.stopPropagation();
      clearSelection();
      return;
    }
    const go = (i: number) => {
      const r = visible[Math.max(0, Math.min(visible.length - 1, i))];
      if (r) selectAndFocus(r.key);
    };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); go(idx < 0 ? 0 : idx + 1); return;
      case "ArrowUp": e.preventDefault(); go(idx < 0 ? visible.length - 1 : idx - 1); return;
      case "Home": e.preventDefault(); go(0); return;
      case "End": e.preventDefault(); go(visible.length - 1); return;
    }
    if (!cur) return;
    if (cur.group) {
      // A virtual site row: expand/collapse and the background menu only.
      const open = isExpanded(cur.group.rel);
      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          if (!open) p.onToggle(cur.group.rel, true); else go(idx + 1);
          return;
        case "ArrowLeft":
          e.preventDefault();
          if (open) p.onToggle(cur.group.rel, false);
          else if (cur.group.folder) selectAndFocus(treeKey(cur.group.folder));
          return;
        case "Enter":
          e.preventDefault();
          p.onToggle(cur.group.rel);
          return;
        case "ContextMenu":
        case "F10": {
          if (e.key === "F10" && !e.shiftKey) return;
          e.preventDefault();
          const r = refs.current.get(cur.key)?.getBoundingClientRect();
          p.onMenu(cur.key, null, r ? r.left + 24 : 0, r ? r.bottom : 0);
        }
      }
      return;
    }
    const node = cur.node!;
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        if (node.dir && !cur.starred) {
          if (!isExpanded(node.rel)) p.onToggle(node.rel, true);
          else if (visible[idx + 1]?.depth > cur.depth) go(idx + 1);
        }
        return;
      case "ArrowLeft": {
        e.preventDefault();
        if (node.dir && !cur.starred && isExpanded(node.rel)) { p.onToggle(node.rel, false); return; }
        if (cur.starred) return;
        if (cur.inGroup) { selectAndFocus(groupKey(cur.inGroup)); return; }
        const parent = parentRel(node.rel);
        if (parent) selectAndFocus(treeKey(parent));
        return;
      }
      case "Enter":
        e.preventDefault();
        p.onActivate(node, cur.key, openModeFromEvent(e));
        return;
      case "F2":
        e.preventDefault();
        p.onRename(cur.key, node);
        return;
      case "Delete":
        e.preventDefault();
        p.onTrash(node);
        return;
      case "ContextMenu":
      case "F10":
        if (e.key === "F10" && !e.shiftKey) return;
        e.preventDefault();
        {
          const r = refs.current.get(cur.key)?.getBoundingClientRect();
          p.onMenu(cur.key, node, r ? r.left + 24 : 0, r ? r.bottom : 0);
        }
    }
  };

  // â”€â”€ drag & drop (pointer-based: native HTML5 DnD is swallowed by Tauri's file-drop) â”€â”€
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [dragging, setDragging] = useState<DragData | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHover = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); hoverTimer.current = null; };

  const onDragStart = (e: DragStartEvent) => setDragging((e.active.data.current as DragData) ?? null);
  const onDragOver = (e: DragOverEvent) => {
    clearHover();
    const d = e.active.data.current as DragData | undefined;
    const folder = (e.over?.data.current as DropData | undefined)?.folder;
    if (!d || folder === undefined || !canMoveTo(d.rel, folder)) { setDropFolder(null); return; }
    setDropFolder(folder);
    // Hovering a collapsed folder opens it so deeper targets become reachable.
    if (folder && !isExpanded(folder)) hoverTimer.current = setTimeout(() => p.onToggle(folder, true), 650);
  };
  const onDragEnd = (e: DragEndEvent) => {
    clearHover();
    const d = e.active.data.current as DragData | undefined;
    const folder = (e.over?.data.current as DropData | undefined)?.folder;
    setDragging(null); setDropFolder(null);
    if (d && folder !== undefined && canMoveTo(d.rel, folder)) p.onMove(d.rel, folder);
  };
  const onDragCancel = () => { clearHover(); setDragging(null); setDropFolder(null); };
  useEffect(() => clearHover, []);

  const onRowSelect = useCallback((key: string, node: TreeNode, e: MouseEvent) => {
    onSelectKey(key);
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    p.onActivate(node, key, openModeFromEvent(e));
  }, [onSelectKey, p.onActivate]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRowOpenNew = useCallback((key: string, node: TreeNode) => {
    onSelectKey(key);
    p.onActivate(node, key, "permanent");
  }, [onSelectKey, p.onActivate]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRowOpenTerminal = useCallback((key: string, node: TreeNode) => {
    onSelectKey(key);
    p.onOpenTerminal?.(node);
  }, [onSelectKey, p.onOpenTerminal]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRowMenu = useCallback((key: string, node: TreeNode, x: number, y: number) => {
    onSelectKey(key);
    p.onMenu(key, node, x, y);
  }, [onSelectKey, p.onMenu]); // eslint-disable-line react-hooks/exhaustive-deps

  const onGroupSelect = useCallback((key: string, group: SiteGroup, e: MouseEvent) => {
    onSelectKey(key);
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    p.onToggle(group.rel);
  }, [onSelectKey, p.onToggle]); // eslint-disable-line react-hooks/exhaustive-deps

  const onGroupMenu = useCallback((key: string, x: number, y: number) => {
    onSelectKey(key);
    p.onMenu(key, null, x, y);
  }, [onSelectKey, p.onMenu]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderRow = (r: VisibleRow) => r.group ? (
    <SiteGroupRow
      key={r.key}
      rowKey={r.key}
      group={r.group}
      depth={r.depth}
      expanded={isExpanded(r.group.rel)}
      selected={selectedKey === r.key}
      onToggle={p.onToggle}
      onSelect={onGroupSelect}
      onMenu={onGroupMenu}
      setRef={setRef}
    />
  ) : r.node && (
    <VaultRow
      key={r.key}
      rowKey={r.key}
      subtitle={p.subtitles?.get(r.node.rel.toLowerCase())}
      node={r.node}
      depth={r.depth}
      expanded={r.node.dir && !r.starred && isExpanded(r.node.rel)}
      selected={selectedKey === r.key}
      isTarget={!!selectedKey && !r.starred && r.node.dir && selectedKey !== r.key && p.targetFolder === r.node.rel}
      isOpen={!r.node.dir && p.openRels.has(r.node.rel.toLowerCase())}
      isDrop={!r.starred && r.node.dir && dropFolder === r.node.rel}
      dropFolder={r.starred ? null : r.node.dir ? r.node.rel : parentRel(r.node.rel)}
      showPath={r.starred}
      editor={p.editingKey === r.key ? p.renderEditor(r.node) : undefined}
      {...rowMarkLabels(p.marks, r.node, r.node.dir && !r.starred && isExpanded(r.node.rel))}
      onSelect={onRowSelect}
      onOpenNew={onRowOpenNew}
      onOpenTerminal={p.onOpenTerminal ? onRowOpenTerminal : undefined}
      onToggle={p.onToggle}
      onMenu={onRowMenu}
      setRef={setRef}
    />
  );

  const selVisible = visible.some((r) => r.key === selectedKey);
  const treeRows = visible.filter((r) => !r.starred);
  const starRows = visible.filter((r) => r.starred);
  const createAt = p.creating
    ? (p.creating.parent ? treeRows.findIndex((r) => r.node?.dir && r.node.rel === p.creating!.parent) : -1)
    : -2;

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin}
                onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
      <div
        ref={treeRef}
        className={`vt-scroll${dropFolder === "" ? " is-drop-root" : ""}`}
        role="tree"
        aria-label="Vault entries"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          // A click on empty space (not a row, button or the name box) clears the selection, VS Code
          // style — New item / New folder then create at the vault root.
          if (e.button !== 0 || isOnControl(e.target)) return;
          skipFocusSelect.current = true;
          requestAnimationFrame(() => { skipFocusSelect.current = false; });
          onSelectKey(null);
        }}
        onContextMenu={(e) => {
          if (isTextFieldTarget(e.target)) return; // inline name box: text menu instead
          e.preventDefault(); e.stopPropagation();
          if (!isOnControl(e.target)) onSelectKey(null); // the background menu acts on the root
          p.onMenu(null, null, e.clientX, e.clientY);
        }}
        onFocus={(e) => {
          // Tabbing into the tree with nothing selected lands on the first row.
          if (e.target === e.currentTarget && !skipFocusSelect.current && !selVisible && visible[0]) {
            selectAndFocus(visible[0].key);
          }
        }}
        tabIndex={selVisible ? -1 : 0}
      >
        {starred.length > 0 && (
          <div role="group" aria-label="Starred">
            <button type="button" className="vt-section" aria-expanded={starredOpen}
                    onClick={() => p.onStarredOpen(!starredOpen)}>
              <ChevronRight size={11} strokeWidth={2.4} className={`vt-row-chevron${starredOpen ? " is-open" : ""}`} aria-hidden />
              <Star size={10} aria-hidden /> Starred <span className="ml-auto font-normal">{starred.length}</span>
            </button>
            {starRows.map(renderRow)}
          </div>
        )}
        {starred.length > 0 && (
          <div className="vt-section" style={{ cursor: "default" }} role="presentation">
            <span className="vt-row-chevron" aria-hidden /> All secrets
          </div>
        )}

        {p.creating && createAt === -1 && p.creating.row}
        {treeRows.length === 0 && !p.creating ? p.empty : treeRows.map((r, i) => (
          <Fragment key={r.key}>
            {renderRow(r)}
            {i === createAt && p.creating?.row}
          </Fragment>
        ))}
        <RootDropZone active={!!dragging} />
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className="vt-drag-ghost">
            <EntryIcon kind={dragging.kind} />
            <span className="truncate">{dragging.name}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/** Empty space below the rows: dropping here moves to the vault's top level. */
function RootDropZone({ active }: { active: boolean }) {
  const { setNodeRef } = useDroppable({ id: ROOT_DROP_ID, data: { folder: "" } satisfies DropData });
  return <div ref={setNodeRef} className="flex-1" style={{ minHeight: active ? 48 : 24 }} aria-hidden />;
}

/** Indented row hosting an inline name editor for something being created. */
export function CreateRow({ depth, kind, children }: { depth: number; kind: TreeNode["kind"]; children: ReactNode }) {
  return (
    <div className="vt-row is-selected" style={{ paddingLeft: 4 + depth * INDENT }} role="treeitem"
         aria-level={depth + 1} aria-selected id={rowDomId("creating")}>
      <span className="vt-row-chevron" aria-hidden />
      <EntryIcon kind={kind} />
      {children}
    </div>
  );
}
