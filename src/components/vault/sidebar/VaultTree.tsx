import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  DndContext, DragOverlay, PointerSensor, pointerWithin, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { ChevronRight, Star } from "lucide-react";
import { canMoveTo, parentRel, type FlatRow, type TreeNode } from "../../../lib/vaultTree";
import { EntryIcon } from "./EntryIcon";
import { INDENT, VaultRow, rowDomId, type DragData, type DropData } from "./VaultRow";

/** A visible, focusable row (Starred group rows and tree rows share one keyboard order). */
export interface VisibleRow { key: string; node: TreeNode; depth: number; starred: boolean }

export const treeKey = (rel: string) => `t:${rel}`;
export const starKey = (rel: string) => `s:${rel}`;

interface Props {
  rows: FlatRow[];
  starred: TreeNode[];
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
  onSelectKey: (key: string | null) => void;
  onActivate: (node: TreeNode, key: string) => void;
  onToggle: (rel: string, open?: boolean) => void;
  onRename: (key: string, node: TreeNode) => void;
  onTrash: (node: TreeNode) => void;
  onMenu: (key: string | null, node: TreeNode | null, x: number, y: number) => void;
  onMove: (rel: string, destFolder: string) => void;
}

const ROOT_DROP_ID = "drop:root";

/** The keyboard-navigable, drag-and-drop file tree (plus the pinned Starred group). */
export function VaultTree(p: Props) {
  const { rows, starred, starredOpen, isExpanded, selectedKey, onSelectKey } = p;

  const visible: VisibleRow[] = useMemo(() => [
    ...(starredOpen ? starred.map((n) => ({ key: starKey(n.rel), node: n, depth: 0, starred: true })) : []),
    ...rows.map((r) => ({ key: treeKey(r.node.rel), node: r.node, depth: r.depth, starred: false })),
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

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Only rows (and the tree itself) drive navigation — not inputs or the section buttons.
    if (!(e.target as HTMLElement).matches('[role="treeitem"], [role="tree"]')) return;
    const idx = visible.findIndex((r) => r.key === selectedKey);
    const cur = idx >= 0 ? visible[idx] : null;
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
    const { node } = cur;
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
        const parent = parentRel(node.rel);
        if (parent) selectAndFocus(treeKey(parent));
        return;
      }
      case "Enter":
        e.preventDefault();
        p.onActivate(node, cur.key);
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
    p.onActivate(node, key);
  }, [onSelectKey, p.onActivate]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRowMenu = useCallback((key: string, node: TreeNode, x: number, y: number) => {
    onSelectKey(key);
    p.onMenu(key, node, x, y);
  }, [onSelectKey, p.onMenu]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderRow = (r: VisibleRow) => (
    <VaultRow
      key={r.key}
      rowKey={r.key}
      node={r.node}
      depth={r.depth}
      expanded={r.node.dir && !r.starred && isExpanded(r.node.rel)}
      selected={selectedKey === r.key}
      isOpen={!r.node.dir && p.openRels.has(r.node.rel.toLowerCase())}
      isDrop={!r.starred && r.node.dir && dropFolder === r.node.rel}
      dropFolder={r.starred ? null : r.node.dir ? r.node.rel : parentRel(r.node.rel)}
      showPath={r.starred}
      editor={p.editingKey === r.key ? p.renderEditor(r.node) : undefined}
      onSelect={onRowSelect}
      onToggle={p.onToggle}
      onMenu={onRowMenu}
      setRef={setRef}
    />
  );

  const selVisible = visible.some((r) => r.key === selectedKey);
  const treeRows = visible.filter((r) => !r.starred);
  const starRows = visible.filter((r) => r.starred);
  const createAt = p.creating
    ? (p.creating.parent ? treeRows.findIndex((r) => r.node.dir && r.node.rel === p.creating!.parent) : -1)
    : -2;

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin}
                onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
      <div
        className={`vt-scroll${dropFolder === "" ? " is-drop-root" : ""}`}
        role="tree"
        aria-label="Vault entries"
        onKeyDown={onKeyDown}
        onContextMenu={(e) => { e.preventDefault(); p.onMenu(null, null, e.clientX, e.clientY); }}
        onFocus={(e) => {
          // Tabbing into the tree with nothing selected lands on the first row.
          if (e.target === e.currentTarget && !selVisible && visible[0]) selectAndFocus(visible[0].key);
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
