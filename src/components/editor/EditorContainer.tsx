import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Plus } from "lucide-react";
import { useAppStore } from "../../store";
import { MonacoMarkdownEditor, type MonacoEditorHandle } from "./MonacoMarkdownEditor";
import { MarkdownPreview, type PreviewHandle } from "./MarkdownPreview";
import { PreviewSearchBar } from "./PreviewSearchBar";
import { Button } from "../ui/Button";
import { getLanguageFromPath, isMarkdownLike } from "../../lib/language";

export const EditorContainer = React.memo(function EditorContainer() {
  const tabs        = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const themeId     = useAppStore((s) => s.themeId);
  const addTab      = useAppStore((s) => s.addTab);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId), [tabs, activeTabId]);

  // ── Resizable split ───────────────────────────────────────────────────────
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef     = useRef(false);
  const [splitPct, setSplitPct]     = useState(50);
  const [isDragging, setIsDragging] = useState(false);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      const { left, width } = splitContainerRef.current.getBoundingClientRect();
      setSplitPct(Math.min(80, Math.max(20, ((e.clientX - left) / width) * 100)));
    };
    const stopDrag = () => {
      if (isDraggingRef.current) { isDraggingRef.current = false; setIsDragging(false); }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stopDrag);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stopDrag);
    };
  }, []);

  // ── Scroll sync ───────────────────────────────────────────────────────────
  const monacoHandleRef  = useRef<MonacoEditorHandle>(null);
  const previewHandleRef = useRef<PreviewHandle>(null);
  // For preview-only mode
  const previewOnlyHandleRef = useRef<PreviewHandle>(null);

  const handleEditorScroll = useCallback((ratio: number) => {
    previewHandleRef.current?.scrollTo(ratio);
  }, []);

  const handlePreviewScroll = useCallback((ratio: number) => {
    monacoHandleRef.current?.scrollTo(ratio);
  }, []);

  // ── Preview search ────────────────────────────────────────────────────────
  const [previewSearchOpen, setPreviewSearchOpen] = useState(false);
  const [previewSearchContainerEl, setPreviewSearchContainerEl] = useState<HTMLElement | null>(null);

  // Close search when tab changes
  useEffect(() => { setPreviewSearchOpen(false); }, [activeTabId]);

  // Ctrl+F in preview-only mode → open preview search instead of nothing
  // Ctrl+F in split mode when preview focused → open preview search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== "f") return;
      if (!activeTab) return;

      const isMd = isMarkdownLike(activeTab.filePath);
      const mode = isMd ? activeTab.editorMode : "markdown";

      if (mode === "preview") {
        // Preview-only: intercept Ctrl+F for our custom search
        e.preventDefault();
        e.stopPropagation();
        const el = previewOnlyHandleRef.current?.getContainerEl() ?? null;
        setPreviewSearchContainerEl(el);
        setPreviewSearchOpen(true);
      } else if (mode === "split") {
        // Split mode: check if focus is NOT inside the Monaco editor
        const active = document.activeElement;
        const inMonaco = active?.closest(".monaco-editor");
        if (!inMonaco) {
          e.preventDefault();
          e.stopPropagation();
          const el = previewHandleRef.current?.getContainerEl() ?? null;
          setPreviewSearchContainerEl(el);
          setPreviewSearchOpen(true);
        }
        // If in Monaco, let Monaco's native Ctrl+F work
      }
    };

    // Use capture phase to intercept before Monaco
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [activeTab]);

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!activeTab) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center gap-5 select-none"
        style={{ background: "var(--color-editor-bg)" }}
      >
        <div
          className="flex items-center justify-center w-14 h-14 rounded-2xl"
          style={{
            background: "color-mix(in srgb, var(--color-primary) 12%, var(--color-bg-secondary))",
            color: "var(--color-primary)",
          }}
        >
          <FileText size={24} strokeWidth={1.5} />
        </div>

        <div className="text-center">
          <p className="text-sm font-semibold mb-1" style={{ color: "var(--color-text)" }}>
            No note open
          </p>
          <p className="text-xs mb-4" style={{ color: "var(--color-text-muted)" }}>
            Create a new note or open an existing file
          </p>
          <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={() => addTab()}>
            New note
          </Button>
        </div>

        <div
          className="grid grid-cols-3 gap-x-5 gap-y-1.5 text-xs mt-1"
          style={{ color: "var(--color-text-muted)" }}
        >
          {[["Ctrl+N", "New"], ["Ctrl+O", "Open"], ["Ctrl+S", "Save"]].map(([k, l]) => (
            <span key={k} className="flex items-center gap-1.5">
              <kbd
                className="px-1.5 py-0.5 rounded font-mono"
                style={{
                  background: "var(--color-bg-secondary)",
                  border: "1px solid var(--color-border)",
                  fontSize: 10,
                }}
              >
                {k}
              </kbd>
              {l}
            </span>
          ))}
        </div>
      </div>
    );
  }

  const language      = activeTab.language ?? getLanguageFromPath(activeTab.filePath);
  const isMdNote      = isMarkdownLike(activeTab.filePath) && !activeTab.language;
  const { id, content, editorMode } = activeTab;
  const effectiveMode = isMdNote ? editorMode : "markdown";

  // Full-width Monaco pane (source mode)
  const MonacoPane = (
    <div
      className="flex-1 min-h-0 overflow-hidden"
      style={{ background: "var(--color-editor-bg)", display: "flex", flexDirection: "column" }}
    >
      <MonacoMarkdownEditor
        tabId={id} content={content} themeId={themeId}
        language={language} horizontalPadding showToolbar={!isMdNote}
      />
    </div>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {effectiveMode === "markdown" && MonacoPane}

        {effectiveMode === "preview" && (
          <div className="relative flex flex-col flex-1 min-h-0 overflow-hidden">
            {previewSearchOpen && (
              <PreviewSearchBar
                containerEl={previewSearchContainerEl}
                onClose={() => setPreviewSearchOpen(false)}
              />
            )}
            <MarkdownPreview ref={previewOnlyHandleRef} content={content} />
          </div>
        )}

        {effectiveMode === "split" && (
          <div
            ref={splitContainerRef}
            className="flex flex-1 min-h-0 overflow-hidden"
            style={{
              cursor: isDragging ? "col-resize" : undefined,
              userSelect: isDragging ? "none" : undefined,
            }}
          >
            {/* ── Left: Editor pane ──────────────────────────────────────── */}
            <div
              className="split-pane"
              style={{ width: `${splitPct}%`, height: "100%" }}
            >
              <div
                className="flex-1 min-h-0 overflow-hidden"
                style={{ background: "var(--color-editor-bg)", display: "flex", flexDirection: "column" }}
              >
                <MonacoMarkdownEditor
                  ref={monacoHandleRef}
                  tabId={id} content={content} themeId={themeId}
                  language={language} onScrollChange={handleEditorScroll} horizontalPadding showToolbar={!isMdNote}
                />
              </div>
            </div>

            {/* ── Divider ───────────────────────────────────────────────── */}
            <div
              className={`split-handle${isDragging ? " is-dragging" : ""}`}
              onMouseDown={startDrag}
              title="Drag to resize"
            >
              <span className="split-handle-grip" />
            </div>

            {/* ── Right: Preview pane ───────────────────────────────────── */}
            <div className="split-pane split-pane--preview" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%" }}>
              {previewSearchOpen && (
                <PreviewSearchBar
                  containerEl={previewSearchContainerEl}
                  onClose={() => setPreviewSearchOpen(false)}
                />
              )}
              <div className="flex-1 min-h-0 overflow-hidden">
                <MarkdownPreview
                  ref={previewHandleRef}
                  content={content}
                  onScrollChange={handlePreviewScroll}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
