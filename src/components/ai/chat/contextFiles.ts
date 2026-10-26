import { useAppStore } from "../../../store";
import { getLanguageFromPath, isMarkdownLike } from "../../../lib/language";
import { getFileName } from "../../../lib/pathUtils";
import { isVaultPath } from "../../../lib/vault";
import type { ChatContextFile } from "../../../lib/ai/prompts";
import type { Tab } from "../../../types";

/** Display label for a tab in the context picker / pill — filename for real
 *  files, title for in-memory notes. */
export function tabLabel(tab: Tab): string {
  return tab.filePath ? getFileName(tab.filePath) : tab.title;
}

/** A real (non-prose) file vs. a markdown note — same distinction the context
 *  block itself uses to decide whether to send fileName/language. */
export function isCodeTab(tab: Tab): boolean {
  return !!tab.filePath && !(isMarkdownLike(tab.filePath) && !tab.language);
}

/** Default context selection: just the currently active note tab (matches the
 *  pre-multi-file behavior). Used for the initial state and every reset. */
export function seedContextTabIds(): Set<string> {
  const st = useAppStore.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  return tab && tab.kind === "note" && !isVaultPath(tab.filePath) ? new Set([tab.id]) : new Set();
}

/** Build one chat-context entry from an open tab, capping its content at `cap`
 *  chars and only surfacing fileName/language for real (non-prose) files —
 *  mirrors the single-file logic this replaced. */
export function tabToContextFile(tab: Tab, cap: number): ChatContextFile {
  const language = tab.language ?? getLanguageFromPath(tab.filePath);
  const isProseNote = !tab.filePath || (isMarkdownLike(tab.filePath) && !tab.language);
  return {
    title: tab.title !== "Untitled" ? tab.title : undefined,
    content: tab.content.slice(0, cap),
    fileName: !isProseNote ? tabLabel(tab) : undefined,
    language: !isProseNote ? language : undefined,
  };
}
