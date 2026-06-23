import {
  Fragment, useState, useRef, useCallback, useEffect,
  forwardRef, useImperativeHandle,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  PanelBottom, PanelRight, Plus, SplitSquareHorizontal, SplitSquareVertical, X,
} from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { TerminalInstance, type InstanceHandle } from "./TerminalInstance";
import type { TerminalLayout } from "../../types";
import "@xterm/xterm/css/xterm.css";

export interface TerminalPanelHandle {
  fit():            void;
  focus():          void;
  newSession():     void;
  closeActivePane(): void;
}

interface Pane {
  id:    number;
  title: string;
  size:  number;   // proportion of the tab (sums to 1.0 across panes in a tab)
}

interface TabGroup {
  id:           number;
  panes:        Pane[];
  activePaneId: number;
}

interface Props {
  isOpen:        boolean;
  onClose:       () => void;
  layout:        TerminalLayout;
  onToggleLayout: () => void;
}

const MIN_PANE_RATIO = 0.1;

export const TerminalPanel = forwardRef<TerminalPanelHandle, Props>(
  function TerminalPanel({ isOpen, onClose, layout, onToggleLayout }, ref) {
    const [tabs,        setTabs]        = useState<TabGroup[]>([]);
    const [activeTabId, setActiveTabId] = useState<number | null>(null);
    const nextIdRef    = useRef(1);
    const instanceRefs = useRef<Map<number, InstanceHandle>>(new Map());
    const bodyRef      = useRef<HTMLDivElement>(null);

    const activeTab = activeTabId !== null ? tabs.find((t) => t.id === activeTabId) ?? null : null;

    // Split direction is perpendicular to the main terminal layout.
    // Horizontal panel (bottom) → split panes side-by-side (row).
    // Vertical panel (right)   → split panes top/bottom (column).
    const splitDir = layout === "horizontal" ? "row" : "column";

    // ── Tab/pane creation ──────────────────────────────────────────────────
    const handleNewTab = useCallback(() => {
      const paneId = nextIdRef.current++;
      const tabId  = nextIdRef.current++;
      setTabs((prev) => [
        ...prev,
        { id: tabId, panes: [{ id: paneId, title: "Shell", size: 1 }], activePaneId: paneId },
      ]);
      setActiveTabId(tabId);
    }, []);

    const handleSplit = useCallback(() => {
      if (activeTabId === null) return;
      const paneId = nextIdRef.current++;
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== activeTabId) return t;
          const n = t.panes.length + 1;
          // Equal redistribution after split keeps things predictable.
          const equalSize = 1 / n;
          return {
            ...t,
            panes: [...t.panes.map((p) => ({ ...p, size: equalSize })),
                    { id: paneId, title: "Shell", size: equalSize }],
            activePaneId: paneId,
          };
        }),
      );
    }, [activeTabId]);

    // ── Pane lifecycle ─────────────────────────────────────────────────────
    const handleShellName = useCallback((paneId: number, name: string) => {
      setTabs((prev) =>
        prev.map((t) => ({
          ...t,
          panes: t.panes.map((p) => (p.id === paneId ? { ...p, title: name } : p)),
        })),
      );
    }, []);

    const handlePaneFocus = useCallback((paneId: number) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.panes.some((p) => p.id === paneId) ? { ...t, activePaneId: paneId } : t,
        ),
      );
    }, []);

    /** Close a single pane. If it's the last one in its tab, close the tab. */
    const handleClosePane = useCallback((paneId: number, e?: React.MouseEvent) => {
      e?.stopPropagation();
      invoke("terminal_kill", { id: paneId }).catch(console.error);
      instanceRefs.current.delete(paneId);
      setTabs((prev) => {
        const next: TabGroup[] = [];
        let closedTabId: number | null = null;
        for (const t of prev) {
          const remaining = t.panes.filter((p) => p.id !== paneId);
          if (remaining.length === t.panes.length) { next.push(t); continue; }
          if (remaining.length === 0) { closedTabId = t.id; continue; }
          // Redistribute the closed pane's size proportionally across remaining panes.
          const total = remaining.reduce((s, p) => s + p.size, 0);
          const rebalanced = remaining.map((p) => ({ ...p, size: p.size / total }));
          const newActive = t.activePaneId === paneId ? rebalanced[rebalanced.length - 1].id : t.activePaneId;
          next.push({ ...t, panes: rebalanced, activePaneId: newActive });
        }
        if (next.length === 0) onClose();
        else if (closedTabId !== null) {
          setActiveTabId((cur) => (cur === closedTabId ? next[next.length - 1].id : cur));
        }
        return next;
      });
    }, [onClose]);

    /** Close an entire tab — kills every pane in it. */
    const handleCloseTab = useCallback((tabId: number, e?: React.MouseEvent) => {
      e?.stopPropagation();
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;
      for (const p of tab.panes) {
        invoke("terminal_kill", { id: p.id }).catch(console.error);
        instanceRefs.current.delete(p.id);
      }
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        if (next.length === 0) onClose();
        else setActiveTabId((cur) => (cur === tabId ? next[next.length - 1].id : cur));
        return next;
      });
    }, [tabs, onClose]);

    // ── Pane resize (drag the inter-pane handle) ──────────────────────────
    const handlePaneResize = useCallback((tabId: number, leftIdx: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const body = bodyRef.current;
      if (!body) return;
      const total = splitDir === "row" ? body.clientWidth : body.clientHeight;
      if (total <= 0) return;

      const startCoord = splitDir === "row" ? e.clientX : e.clientY;
      // Snapshot current sizes for the affected tab.
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const startLeft  = tab.panes[leftIdx].size;
      const startRight = tab.panes[leftIdx + 1].size;

      const onMove = (ev: MouseEvent) => {
        const cur = splitDir === "row" ? ev.clientX : ev.clientY;
        const deltaPx = cur - startCoord;
        const deltaRatio = deltaPx / total;
        let newLeft  = startLeft  + deltaRatio;
        let newRight = startRight - deltaRatio;
        if (newLeft  < MIN_PANE_RATIO) { newRight -= MIN_PANE_RATIO - newLeft;  newLeft  = MIN_PANE_RATIO; }
        if (newRight < MIN_PANE_RATIO) { newLeft  -= MIN_PANE_RATIO - newRight; newRight = MIN_PANE_RATIO; }
        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== tabId) return t;
            const panes = t.panes.map((p, i) => {
              if (i === leftIdx)     return { ...p, size: newLeft  };
              if (i === leftIdx + 1) return { ...p, size: newRight };
              return p;
            });
            return { ...t, panes };
          }),
        );
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        // Re-fit each xterm instance after the drag settles so columns/rows match new pixel size.
        requestAnimationFrame(() => {
          for (const handle of instanceRefs.current.values()) handle.fit();
        });
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }, [tabs, splitDir]);

    // ── Expose imperative handle to parent ─────────────────────────────────
    useImperativeHandle(ref, () => ({
      fit() {
        for (const handle of instanceRefs.current.values()) handle.fit();
      },
      focus() {
        if (!activeTab) return;
        instanceRefs.current.get(activeTab.activePaneId)?.focus();
      },
      newSession: handleNewTab,
      closeActivePane() {
        if (activeTab) handleClosePane(activeTab.activePaneId);
      },
    }), [activeTab, handleNewTab, handleClosePane]);

    // First-open: create initial tab with one pane.
    useEffect(() => {
      if (isOpen && tabs.length === 0) handleNewTab();
    }, [isOpen, tabs.length, handleNewTab]);

    // Re-fit + focus when active tab or layout changes.
    useEffect(() => {
      if (!activeTab || !isOpen) return;
      requestAnimationFrame(() => {
        for (const p of activeTab.panes) instanceRefs.current.get(p.id)?.fit();
        instanceRefs.current.get(activeTab.activePaneId)?.focus();
      });
    }, [activeTab, isOpen, layout]);

    return (
      <div className="terminal-panel">

        {/* ── Header: tabs + split / new / close ─────────────────────────── */}
        <div className="terminal-header">

          <div className="terminal-tabs">
            {tabs.map((t) => {
              const titlePane = t.panes.find((p) => p.id === t.activePaneId) ?? t.panes[0];
              const title = t.panes.length > 1
                ? `${titlePane.title} (${t.panes.length})`
                : titlePane.title;
              return (
                <button
                  key={t.id}
                  className={`terminal-tab${t.id === activeTabId ? " is-active" : ""}`}
                  onClick={() => setActiveTabId(t.id)}
                >
                  <span className="terminal-tab-title">{title}</span>
                  <span
                    className="terminal-tab-close"
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => handleCloseTab(t.id, e)}
                  >
                    <X size={10} />
                  </span>
                </button>
              );
            })}
          </div>

          <div className="terminal-header-actions">
            <Tooltip content="Split Terminal">
              <button className="terminal-icon-btn" onClick={handleSplit}>
                {splitDir === "row"
                  ? <SplitSquareHorizontal size={13} />
                  : <SplitSquareVertical   size={13} />}
              </button>
            </Tooltip>
            <Tooltip
              content={layout === "horizontal" ? "Move to right" : "Move to bottom"}
              shortcut="Ctrl+Shift+\"
            >
              <button className="terminal-icon-btn" onClick={onToggleLayout}>
                {layout === "horizontal"
                  ? <PanelRight  size={13} />
                  : <PanelBottom size={13} />}
              </button>
            </Tooltip>
            <Tooltip content="New Terminal" shortcut="Ctrl+Shift+`">
              <button className="terminal-icon-btn" onClick={handleNewTab}>
                <Plus size={13} />
              </button>
            </Tooltip>
            <Tooltip content="Close panel" shortcut="Ctrl+`">
              <button className="terminal-icon-btn" onClick={onClose}>
                <X size={12} />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* ── Body: panes of the active tab side-by-side ─────────────────── */}
        <div className="terminal-body" ref={bodyRef}>
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`terminal-panes split-${splitDir}`}
              style={{ display: t.id === activeTabId ? "flex" : "none" }}
            >
              {t.panes.map((p, idx) => (
                <Fragment key={p.id}>
                  <div
                    className={`terminal-pane${
                      t.panes.length > 1 && p.id === t.activePaneId ? " is-active-pane" : ""
                    }`}
                    style={{ flex: `${p.size} ${p.size} 0` }}
                    onMouseDown={() => handlePaneFocus(p.id)}
                  >
                    <TerminalInstance
                      ref={(handle) => {
                        if (handle) instanceRefs.current.set(p.id, handle);
                        else        instanceRefs.current.delete(p.id);
                      }}
                      sessionId={p.id}
                      isActive={t.id === activeTabId}
                      isOpen={isOpen}
                      onShellName={handleShellName}
                      onExit={() => { /* pane stays open until user closes it */ }}
                      onFocus={handlePaneFocus}
                    />
                    {t.panes.length > 1 && (
                      <button
                        className="terminal-pane-close"
                        onClick={(e) => handleClosePane(p.id, e)}
                        aria-label="Close pane"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </div>
                  {idx < t.panes.length - 1 && (
                    <div
                      className="terminal-pane-resize"
                      onMouseDown={(e) => handlePaneResize(t.id, idx, e)}
                    />
                  )}
                </Fragment>
              ))}
            </div>
          ))}
        </div>

      </div>
    );
  },
);
