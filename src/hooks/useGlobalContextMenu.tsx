import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { editor as MonacoEditor } from "monaco-editor";
import { useAppStore } from "../store";
import { useVaultStore } from "../store/vaultStore";
import { isMarkdownLike } from "../lib/language";
import { getEditorFromTarget } from "../lib/activeEditor";
import { aiContinue, aiSummarize, aiFixGrammar, aiGenerateTitle, aiFixMermaid } from "../lib/ai/actions";
import { mermaidFenceAt } from "../lib/ai/context";
import { classifyContextTarget } from "../lib/contextMenu/target";
import { buildEditorMenu, buildPreviewMenu, buildTabStripMenu, buildVaultLockedMenu } from "../lib/contextMenu/items";
import { buildTextFieldMenu, textFieldAt } from "../lib/contextMenu/textField";
import { monacoEditActions, monacoEditState } from "../lib/contextMenu/monacoActions";
import type { ContextMenuItem } from "../components/ui/ContextMenu";

interface Options {
  handleOpenMultiple:  () => void;
  handleOpenFolder:    () => void;
  handleNewWhiteboard: () => void;
}

export interface CtxMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/**
 * Main-window right-click handler. Each surface gets the menu for what was
 * clicked (see classifyContextTarget); surfaces with their own menu (tabs, vault
 * tree, terminal, whiteboard) handle the event first and mark it handled, and
 * everything else gets no menu at all — never the browser's.
 */
export function useGlobalContextMenu(opts: Options) {
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  const tabs        = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const addTab      = useAppStore((s) => s.addTab);
  const aiEnabled   = useAppStore((s) => s.aiEnabled);

  // Keep latest values in a ref so the event listener doesn't need to be
  // re-registered every time a dependency changes.
  const ref = useRef({ tabs, activeTabId, addTab, aiEnabled, ...opts });
  ref.current = { tabs, activeTabId, addTab, aiEnabled, ...opts };

  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      const area = classifyContextTarget(t);

      // A surface that opened its own menu already called preventDefault.
      // (Monaco never does, so the editor is always ours.)
      if (area !== "editor" && e.defaultPrevented) return;
      e.preventDefault();

      const items = buildFor(area, t, e, ref.current);
      setCtxMenu(items.length ? { x: e.clientX, y: e.clientY, items } : null);
    };

    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []); // Stable — reads from ref.current

  return { ctxMenu, closeCtxMenu: () => setCtxMenu(null) };
}

interface Ctx extends Options {
  tabs: { id: string; kind: string; filePath?: string }[];
  activeTabId: string | null;
  addTab: () => void;
  aiEnabled: boolean;
}

function buildFor(area: ReturnType<typeof classifyContextTarget>, t: Element | null, e: MouseEvent, c: Ctx): ContextMenuItem[] {
  switch (area) {
    case "editor": {
      const ed = getEditorFromTarget(t);
      return ed ? editorItems(ed, e, c) : [];
    }
    case "text-field": {
      const field = textFieldAt(t);
      return field ? buildTextFieldMenu(field) : [];
    }
    case "preview":
      return previewItems(t);
    case "tab-strip":
      return buildTabStripMenu({
        newNote: c.addTab,
        newWhiteboard: c.handleNewWhiteboard,
        openFiles: c.handleOpenMultiple,
        openFolder: c.handleOpenFolder,
      });
    case "vault-locked": {
      const v = useVaultStore.getState();
      return buildVaultLockedMenu(v.exists, () => { void v.ensureUnlocked(); });
    }
    default:
      return [];
  }
}

function editorItems(ed: MonacoEditor.ICodeEditor, e: MouseEvent, c: Ctx): ContextMenuItem[] {
  // Monaco doesn't always move the caret on right-click; align it to the
  // click point (when nothing is selected) so cursor-based actions like
  // "Fix Mermaid" operate where the user actually right-clicked.
  const sel0 = ed.getSelection();
  if (!sel0 || sel0.isEmpty()) {
    const tgt = ed.getTargetAtClientPoint?.(e.clientX, e.clientY);
    if (tgt?.position) ed.setPosition(tgt.position);
  }

  const model = ed.getModel();
  const pos   = ed.getPosition();
  const activeTab = c.tabs.find((x) => x.id === c.activeTabId);
  const format = ed.getAction?.("smart-note.format");

  return buildEditorMenu(
    {
      ...monacoEditState(ed),
      aiEnabled: c.aiEnabled,
      isMarkdownNote: activeTab?.kind === "note" && isMarkdownLike(activeTab.filePath),
      inMermaid: !!(model && pos && mermaidFenceAt(model, pos)),
    },
    {
      ...monacoEditActions(ed),
      find: () => { ed.trigger("ctx-menu", "actions.find", null); },
      replace: () => { ed.trigger("ctx-menu", "editor.action.startFindReplaceAction", null); },
      format: format ? () => { void format.run(); } : undefined,
      aiContinue: () => { void aiContinue(ed); },
      aiFixGrammar: () => { void aiFixGrammar(ed); },
      aiSummarize: () => { void aiSummarize(ed); },
      aiGenerateTitle: () => { void aiGenerateTitle(ed); },
      aiFixMermaid: () => { void aiFixMermaid(ed); },
    },
  );
}

function previewItems(t: Element | null): ContextMenuItem[] {
  const sel  = window.getSelection();
  const body = t?.closest(".prose-scroll")?.querySelector(".prose-body") ?? null;
  const link = t?.closest<HTMLAnchorElement>("a[href]")?.getAttribute("href") ?? null;
  return buildPreviewMenu(
    { hasSelection: !!sel?.toString().trim(), linkHref: link },
    {
      copy: () => { const s = window.getSelection()?.toString(); if (s) void writeText(s); },
      selectAll: () => {
        if (!body) return;
        const range = document.createRange();
        range.selectNodeContents(body);
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(range);
      },
      copyLink: () => { if (link) void writeText(link); },
    },
  );
}
