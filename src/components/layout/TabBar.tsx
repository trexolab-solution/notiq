import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, Plus, HardDrive, PenTool, ChevronLeft, ChevronRight, Pin, PinOff, Settings as SettingsIcon } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAppStore } from "../../store";
import { useVaultStore } from "../../store/vaultStore";
import { Input } from "../ui/Input";
import { Tooltip } from "../ui/Tooltip";
import { ContextMenu } from "../ui/ContextMenu";
import { buildTabMenu } from "../../lib/contextMenu/items";
import { isTextFieldTarget } from "../../lib/contextMenu/target";
import type { Tab } from "../../types";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { toast } from "../../lib/toast";
import { isVaultPath } from "../../lib/vault";
import { remove } from "@tauri-apps/plugin-fs";

// ── Context Menu ──────────────────────────────────────────────────────────────
interface TabContextMenuState {
  x: number;
  y: number;
  tabId: string;
  isPinned: boolean;
  title: string;
  /** Plain note that can be locked into the vault. */
  canLock: boolean;
  /** Already a vault note (locked or unlocked). */
  isVault: boolean;
  /** False for the Settings tab (fixed title). */
  canRename: boolean;
}

// ── Sortable Tab Item ────────────────────────────────────────────────────────
interface SortableTabProps {
  tab: Tab;
  isActive: boolean;
  editingId: string | null;
  editValue: string;
  onActivate: (id: string) => void;
  onClose: (id: string, e: React.MouseEvent) => void;
  onTogglePin: (id: string, e: React.MouseEvent) => void;
  onEditChange: (v: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
  onDoubleClick: (id: string, title: string) => void;
  onContextMenu: (e: React.MouseEvent, tab: Tab) => void;
}

export interface TabBarProps {
  /** Override the default close behaviour (e.g. to show a confirmation). */
  onCloseTab?: (id: string, e: React.MouseEvent) => void;
}

function SortableTab({
  tab, isActive, editingId, editValue,
  onActivate, onClose, onTogglePin, onEditChange, onEditCommit, onEditCancel, onDoubleClick, onContextMenu,
}: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onActivate(tab.id)}
      onContextMenu={(e) => onContextMenu(e, tab)}
      className={`tab-item${isActive ? " is-active" : ""}${isDragging ? " is-dragging" : ""}${tab.isPinned ? " is-pinned" : ""}`}
    >
      {/* State indicator */}
      {tab.kind === "whiteboard" ? (
        <PenTool size={9} className="tab-wb-icon" />
      ) : tab.kind === "settings" ? (
        <SettingsIcon size={10} aria-hidden style={{ color: "var(--color-text-muted)", flexShrink: 0 }} />
      ) : tab.isDirty ? (
        <span className="tab-dot" />
      ) : tab.filePath ? (
        <HardDrive size={9} style={{ color: "var(--color-success)", flexShrink: 0 }} />
      ) : null}

      {/* Title or inline rename */}
      {editingId === tab.id ? (
        <Input
          autoFocus
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          onBlur={onEditCommit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onEditCommit();
            if (e.key === "Escape") onEditCancel();
          }}
          className="h-5 text-xs px-1 py-0 flex-1"
          onClick={(e) => e.stopPropagation()}
          style={{ pointerEvents: "auto" }}
        />
      ) : (
        <Tooltip content={tab.filePath ?? tab.title} delay={800} disabled={!tab.filePath}>
          <span
            className="tab-title"
            onDoubleClick={(e) => { e.stopPropagation(); if (tab.kind !== "settings") onDoubleClick(tab.id, tab.title); }}
          >
            {tab.title}
          </span>
        </Tooltip>
      )}

      {/* Pin / Close buttons */}
      {tab.isPinned ? (
        /* Pinned: show unpin icon in place of close button */
        <Tooltip content="Unpin tab">
          <button
            className="tab-pin-btn is-pinned-icon"
            onClick={(e) => onTogglePin(tab.id, e)}
            style={{ pointerEvents: "auto" }}
          >
            <PinOff size={10} strokeWidth={2} />
          </button>
        </Tooltip>
      ) : (
        /* Unpinned: show pin icon + close button on hover */
        <>
          <Tooltip content="Pin tab">
            <button
              className="tab-pin-btn"
              onClick={(e) => onTogglePin(tab.id, e)}
              style={{ pointerEvents: "auto" }}
            >
              <Pin size={10} strokeWidth={2} />
            </button>
          </Tooltip>
          <Tooltip content="Close" shortcut="Ctrl+W">
            <button
              className="tab-close-btn"
              onClick={(e) => onClose(tab.id, e)}
              style={{ pointerEvents: "auto" }}
            >
              <X size={10} strokeWidth={2.5} />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  );
}

// ── TabBar ───────────────────────────────────────────────────────────────────
export const TabBar = React.memo(function TabBar({ onCloseTab }: TabBarProps) {
  const tabs           = useAppStore((s) => s.tabs);
  const activeTabId    = useAppStore((s) => s.activeTabId);
  const addTab         = useAppStore((s) => s.addTab);
  const removeTab      = useAppStore((s) => s.removeTab);
  const setActiveTab   = useAppStore((s) => s.setActiveTab);
  const updateTabTitle = useAppStore((s) => s.updateTabTitle);
  const reorderTabs    = useAppStore((s) => s.reorderTabs);
  const togglePinTab   = useAppStore((s) => s.togglePinTab);
  const lockTabToVault = useAppStore((s) => s.lockTabToVault);
  const lockVault       = useAppStore((s) => s.lockVault);
  const vaultUnlocked   = useVaultStore((s) => s.unlocked);
  // Original unencrypted file left behind after locking — ask before deleting.
  const [plainLeftover, setPlainLeftover] = useState<{ path: string; title: string } | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const stripRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // ── Context menu state ──────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<TabContextMenuState | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, tab: Tab) => {
    if (isTextFieldTarget(e.target)) return; // rename box: text menu instead
    e.preventDefault();
    e.stopPropagation();
    const isVault = isVaultPath(tab.filePath);
    setCtxMenu({
      x: e.clientX, y: e.clientY, tabId: tab.id, isPinned: tab.isPinned, title: tab.title,
      canLock: tab.kind === "note" && !isVault, isVault, canRename: tab.kind !== "settings",
    });
  }, []);

  // ── Overflow detection ──────────────────────────────────────────────────
  const updateScrollState = useCallback(() => {
    const el = stripRef.current; if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = stripRef.current; if (!el) return;
    el.addEventListener("scroll", updateScrollState, { passive: true });
    const obs = new ResizeObserver(updateScrollState);
    obs.observe(el);
    return () => { el.removeEventListener("scroll", updateScrollState); obs.disconnect(); };
  }, [updateScrollState]);

  // Re-check whenever tab count changes
  useEffect(updateScrollState, [tabs.length, updateScrollState]);

  // ── Scroll active tab into view ─────────────────────────────────────────
  useEffect(() => {
    if (!activeTabId) return;
    // Small delay so the DOM settles after tab add
    const id = setTimeout(() => {
      const el = stripRef.current; if (!el) return;
      const active = el.querySelector(".tab-item.is-active") as HTMLElement | null;
      if (!active) return;
      const stripRect = el.getBoundingClientRect();
      const tabRect = active.getBoundingClientRect();
      if (tabRect.left < stripRect.left) {
        el.scrollBy({ left: tabRect.left - stripRect.left - 8, behavior: "smooth" });
      } else if (tabRect.right > stripRect.right) {
        el.scrollBy({ left: tabRect.right - stripRect.right + 8, behavior: "smooth" });
      }
    }, 50);
    return () => clearTimeout(id);
  }, [activeTabId, tabs.length]);

  // ── Horizontal wheel scroll ─────────────────────────────────────────────
  useEffect(() => {
    const el = stripRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollBy({ left: e.deltaY, behavior: "auto" });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const scrollBy = useCallback((dir: number) => {
    stripRef.current?.scrollBy({ left: dir * 160, behavior: "smooth" });
  }, []);

  const startEdit   = useCallback((id: string, title: string) => { setEditingId(id); setEditValue(title); }, []);
  const commitEdit  = useCallback(() => {
    if (editingId && editValue.trim()) updateTabTitle(editingId, editValue.trim());
    setEditingId(null);
  }, [editingId, editValue, updateTabTitle]);
  const handleClose = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onCloseTab) onCloseTab(id, e); else removeTab(id);
  }, [onCloseTab, removeTab]);
  const handleTogglePin = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    togglePinTab(id);
  }, [togglePinTab]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const draggedTab = tabs.find((t) => t.id === active.id);
    const targetTab  = tabs.find((t) => t.id === over.id);
    if (!draggedTab || !targetTab) return;

    // Enforce pin boundary: pinned tabs only with pinned, unpinned only with unpinned
    if (draggedTab.isPinned !== targetTab.isPinned) return;

    const oldIndex = tabs.findIndex((t) => t.id === active.id);
    const newIndex = tabs.findIndex((t) => t.id === over.id);
    reorderTabs(arrayMove(tabs, oldIndex, newIndex));
  }, [tabs, reorderTabs]);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div className="tab-strip-wrapper">
        {/* Left scroll chevron */}
        {canScrollLeft && (
          <button className="tab-scroll-btn tab-scroll-left" onClick={() => scrollBy(-1)}>
            <ChevronLeft size={14} strokeWidth={2} />
          </button>
        )}

        <div className="tab-strip" ref={stripRef}>
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              return (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  isActive={isActive}
                  editingId={editingId}
                  editValue={editValue}
                  onActivate={setActiveTab}
                  onClose={handleClose}
                  onTogglePin={handleTogglePin}
                  onEditChange={setEditValue}
                  onEditCommit={commitEdit}
                  onEditCancel={() => setEditingId(null)}
                  onDoubleClick={startEdit}
                  onContextMenu={handleContextMenu}
                />
              );
            })}
          </SortableContext>

          {/* New tab */}
          <Tooltip content="New tab" shortcut="Ctrl+N">
            <button className="tab-new-btn" onClick={() => addTab()}>
              <Plus size={12} strokeWidth={2} />
            </button>
          </Tooltip>
        </div>

        {/* Right scroll chevron */}
        {canScrollRight && (
          <button className="tab-scroll-btn tab-scroll-right" onClick={() => scrollBy(1)}>
            <ChevronRight size={14} strokeWidth={2} />
          </button>
        )}
      </div>

      {/* ── Right-click Context Menu ─────────────────────────────────────── */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={buildTabMenu(
            { ...ctxMenu, vaultUnlocked },
            {
              togglePin: () => togglePinTab(ctxMenu.tabId),
              rename: () => startEdit(ctxMenu.tabId, ctxMenu.title),
              lockToVault: async () => {
                const res = await lockTabToVault(ctxMenu.tabId);
                if (res.ok && res.plainPath) {
                  setPlainLeftover({ path: res.plainPath, title: ctxMenu.title });
                }
              },
              lockVault: () => { void lockVault(); },
              close: () => {
                const fakeEvent = { stopPropagation: () => {} } as React.MouseEvent;
                handleClose(ctxMenu.tabId, fakeEvent);
              },
            },
          )}
        />
      )}

      {plainLeftover && (
        <ConfirmDialog
          title="Delete the unencrypted original?"
          message="Your note is now locked in a .nqv file, but the original plain-text file is still on disk and anyone can read it. Delete it now?"
          detail={plainLeftover.path}
          icon="file"
          confirmLabel="Delete original"
          cancelLabel="Keep it"
          danger
          onConfirm={async () => {
            const { path } = plainLeftover;
            setPlainLeftover(null);
            try {
              await remove(path);
              toast.info("Original file deleted");
            } catch (e) {
              console.error("vault: couldn't delete original", e);
              toast.error("Couldn't delete the original — please delete it yourself");
            }
          }}
          onCancel={() => {
            setPlainLeftover(null);
            toast.warning("The unencrypted original is still on disk");
          }}
        />
      )}
    </DndContext>
  );
});
