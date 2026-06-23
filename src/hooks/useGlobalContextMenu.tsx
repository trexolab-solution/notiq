import { useEffect, useRef, useState } from "react";
import {
  AlignLeft, Clipboard, Copy, Network, Replace, RotateCcw, RotateCw,
  Scissors, Search, SquareMousePointer, PenLine, FileText, SpellCheck, Heading, Workflow,
} from "lucide-react";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "../store";
import { exportToPDF } from "../lib/pdfExport";
import { isMarkdownLike } from "../lib/language";
import { buildFileMenuItems } from "../lib/menuItems";
import { isInEditor, isInPreview, isInTabBar, isInTerminal, isInWhiteboard, isInChat } from "../lib/dom";
import { getEditorFromTarget } from "../lib/activeEditor";
import { aiContinue, aiSummarize, aiFixGrammar, aiGenerateTitle, aiFixMermaid } from "../lib/ai/actions";
import { mermaidFenceAt } from "../lib/ai/context";
import type { ContextMenuItem } from "../components/ui/ContextMenu";

interface Options {
  requestClose:        (id: string) => void;
  handleOpenMultiple:  () => void;
  handleOpenFolder:    () => void;
  handleNewWhiteboard: () => void;
  onShowGraph:         () => void;
}

export interface CtxMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function useGlobalContextMenu(opts: Options) {
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  const tabs            = useAppStore((s) => s.tabs);
  const activeTabId     = useAppStore((s) => s.activeTabId);
  const addTab          = useAppStore((s) => s.addTab);
  const saveTabToFile   = useAppStore((s) => s.saveTabToFile);
  const saveTabToFileAs = useAppStore((s) => s.saveTabToFileAs);
  const aiEnabled       = useAppStore((s) => s.aiEnabled);

  // Keep latest values in a ref so the event listener doesn't need to be
  // re-registered every time a dependency changes.
  const ref = useRef({
    tabs, activeTabId, addTab, saveTabToFile, saveTabToFileAs, aiEnabled, ...opts,
  });
  ref.current = {
    tabs, activeTabId, addTab, saveTabToFile, saveTabToFileAs, aiEnabled, ...opts,
  };

  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const {
        tabs, activeTabId, addTab, saveTabToFile, saveTabToFileAs, aiEnabled,
        requestClose, handleOpenMultiple, handleOpenFolder, handleNewWhiteboard, onShowGraph,
      } = ref.current;
      const activeTab = tabs.find((t) => t.id === activeTabId);
      const t = e.target;

      // These areas handle their own context menus
      if (isInWhiteboard(t)) return;
      if (isInTerminal(t)) return;
      if (isInTabBar(t)) return;

      e.preventDefault();

      // ── Chat input / panel: a plain text-edit menu (not the File menu) ────
      if (isInChat(t)) {
        const ta = t instanceof Element ? t.closest("textarea") as HTMLTextAreaElement | null : null;
        const items: ContextMenuItem[] = [];
        if (ta) {
          const hasSel = ta.selectionStart !== ta.selectionEnd;
          const spliceValue = (next: string, caret: number) => {
            // Use the native setter so React's onChange fires and state updates.
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            setter?.call(ta, next);
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            ta.focus();
            ta.setSelectionRange(caret, caret);
          };
          items.push(
            {
              type: "item", label: "Cut", icon: <Scissors size={13} />, shortcut: "Ctrl+X", disabled: !hasSel,
              onClick: async () => {
                const s = ta.selectionStart, e2 = ta.selectionEnd;
                await writeText(ta.value.slice(s, e2));
                spliceValue(ta.value.slice(0, s) + ta.value.slice(e2), s);
              },
            },
            {
              type: "item", label: "Copy", icon: <Copy size={13} />, shortcut: "Ctrl+C", disabled: !hasSel,
              onClick: async () => { await writeText(ta.value.slice(ta.selectionStart, ta.selectionEnd)); ta.focus(); },
            },
            {
              type: "item", label: "Paste", icon: <Clipboard size={13} />, shortcut: "Ctrl+V",
              onClick: async () => {
                const clip = await readText().catch(() => "");
                if (!clip) { ta.focus(); return; }
                const s = ta.selectionStart, e2 = ta.selectionEnd;
                spliceValue(ta.value.slice(0, s) + clip + ta.value.slice(e2), s + clip.length);
              },
            },
            { type: "separator" },
            {
              type: "item", label: "Select All", icon: <SquareMousePointer size={13} />, shortcut: "Ctrl+A",
              onClick: () => { ta.focus(); ta.select(); },
            },
          );
        }
        if (items.length) setCtxMenu({ x: e.clientX, y: e.clientY, items });
        return;
      }

      // ── Editor-specific context menu ──────────────────────────────────────
      if (isInEditor(t)) {
        const ed = getEditorFromTarget(t);
        if (!ed) return;

        // Monaco doesn't always move the caret on right-click; align it to the
        // click point (when nothing is selected) so cursor-based actions like
        // "Fix Mermaid" operate where the user actually right-clicked.
        const sel0 = ed.getSelection();
        if (!sel0 || sel0.isEmpty()) {
          const tgt = ed.getTargetAtClientPoint?.(e.clientX, e.clientY);
          if (tgt?.position) ed.setPosition(tgt.position);
        }

        const sel          = ed.getSelection();
        const hasSelection = sel ? !sel.isEmpty() : false;

        const items: ContextMenuItem[] = [
          {
            type: "item", label: "Cut", icon: <Scissors size={13} />, shortcut: "Ctrl+X",
            disabled: !hasSelection,
            onClick: async () => {
              const selection = ed.getSelection();
              const model     = ed.getModel();
              if (selection && model && !selection.isEmpty()) {
                await writeText(model.getValueInRange(selection));
                ed.executeEdits("ctx-cut", [{ range: selection, text: "", forceMoveMarkers: true }]);
              }
              ed.focus();
            },
          },
          {
            type: "item", label: "Copy", icon: <Copy size={13} />, shortcut: "Ctrl+C",
            disabled: !hasSelection,
            onClick: async () => {
              const selection = ed.getSelection();
              const model     = ed.getModel();
              if (selection && model && !selection.isEmpty()) {
                await writeText(model.getValueInRange(selection));
              }
              ed.focus();
            },
          },
          {
            type: "item", label: "Paste", icon: <Clipboard size={13} />, shortcut: "Ctrl+V",
            onClick: async () => {
              const text = await readText().catch(() => "");
              ed.focus();
              if (text) ed.trigger("ctx-paste", "type", { text });
            },
          },
          { type: "separator" },
          {
            type: "item", label: "Undo", icon: <RotateCcw size={13} />, shortcut: "Ctrl+Z",
            onClick: () => { ed.trigger("ctx-menu", "undo", null); ed.focus(); },
          },
          {
            type: "item", label: "Redo", icon: <RotateCw size={13} />, shortcut: "Ctrl+Y",
            onClick: () => { ed.trigger("ctx-menu", "redo", null); ed.focus(); },
          },
          { type: "separator" },
          {
            type: "item", label: "Select All", icon: <SquareMousePointer size={13} />, shortcut: "Ctrl+A",
            onClick: () => {
              const model = ed.getModel();
              if (model) ed.setSelection(model.getFullModelRange());
              ed.focus();
            },
          },
          { type: "separator" },
          {
            type: "item", label: "Find", icon: <Search size={13} />, shortcut: "Ctrl+F",
            onClick: () => { ed.trigger("ctx-menu", "actions.find", null); },
          },
          {
            type: "item", label: "Replace", icon: <Replace size={13} />, shortcut: "Ctrl+H",
            onClick: () => { ed.trigger("ctx-menu", "editor.action.startFindReplaceAction", null); },
          },
          { type: "separator" },
          {
            type: "item", label: "Format Document", icon: <AlignLeft size={13} />, shortcut: "Shift+Alt+F",
            onClick: () => { ed.getAction?.("smart-note.format")?.run(); },
          },
        ];

        if (aiEnabled) {
          // Only offer note-oriented AI actions on markdown/memory notes; show
          // generic text actions everywhere; "Fix Mermaid" only inside a fence.
          const isMdNote = activeTab?.kind === "note" && isMarkdownLike(activeTab?.filePath);
          const model = ed.getModel();
          const pos = ed.getPosition();
          const inMermaid = !!(model && pos && mermaidFenceAt(model, pos));

          const aiItems: ContextMenuItem[] = [
            { type: "item", label: "Continue Writing", icon: <PenLine size={13} />, shortcut: "Alt+\\", onClick: () => { void aiContinue(ed); } },
            { type: "item", label: "Fix Grammar",      icon: <SpellCheck size={13} />, onClick: () => { void aiFixGrammar(ed); } },
          ];
          if (isMdNote) {
            aiItems.push(
              { type: "item", label: "Summarize Note", icon: <FileText size={13} />, onClick: () => { void aiSummarize(ed); } },
              { type: "item", label: "Generate Title", icon: <Heading size={13} />, onClick: () => { void aiGenerateTitle(ed); } },
            );
          }
          if (inMermaid) {
            aiItems.push({ type: "item", label: "Fix Mermaid", icon: <Workflow size={13} />, onClick: () => { void aiFixMermaid(ed); } });
          }
          items.push({ type: "separator" }, { type: "label", label: "AI" }, ...aiItems);
        }

        setCtxMenu({ x: e.clientX, y: e.clientY, items });
        return;
      }

      // ── Preview / general context menu ────────────────────────────────────
      const items: ContextMenuItem[] = [];

      if (isInPreview(t)) {
        const currentSel   = window.getSelection();
        const hasSelection = !!(currentSel && currentSel.toString().trim());
        const previewBody  = t instanceof Element
          ? t.closest(".prose-scroll")?.querySelector(".prose-body") ?? null
          : null;

        items.push({ type: "label", label: "Preview" });
        items.push({
          type: "item", label: "Copy", icon: <Copy size={13} />, shortcut: "Ctrl+C",
          disabled: !hasSelection,
          onClick: async () => {
            const sel = window.getSelection();
            if (sel && sel.toString()) {
              await writeText(sel.toString());
            }
          },
        });
        items.push({
          type: "item", label: "Select All", icon: <SquareMousePointer size={13} />, shortcut: "Ctrl+A",
          onClick: () => {
            if (previewBody) {
              const range = document.createRange();
              range.selectNodeContents(previewBody);
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range);
            }
          },
        });
        items.push({ type: "separator" });
      }

      const isNote = activeTab?.kind === "note";
      const isMd   = isNote && isMarkdownLike(activeTab?.filePath);
      items.push({ type: "label", label: "File" });
      items.push(...buildFileMenuItems({
        addTab,
        onNewWhiteboard: handleNewWhiteboard,
        onOpenMultiple: handleOpenMultiple,
        onOpenFolder: handleOpenFolder,
        saveTabToFile,
        saveTabToFileAs,
        exportPDF: () => activeTab && exportToPDF(activeTab.title, activeTab.content),
        requestClose,
        activeTab: activeTab ?? null,
        isMd: !!isMd,
        isNote: !!isNote,
      }));
      items.push({ type: "separator" });
      items.push({ type: "item", label: "Knowledge Graph", icon: <Network size={13} />, onClick: onShowGraph });

      setCtxMenu({ x: e.clientX, y: e.clientY, items });
    };

    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []); // Stable — reads from ref.current

  return { ctxMenu, closeCtxMenu: () => setCtxMenu(null) };
}
