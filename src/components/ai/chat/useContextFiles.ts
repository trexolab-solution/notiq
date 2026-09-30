import { useCallback, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useAppStore } from "../../../store";
import { seedContextTabIds } from "./contextFiles";

/**
 * Which open note/file tabs are shared as chat context, plus the note-context
 * on/off toggle and the file-picker popover's open state. Extracted 1:1 from
 * AIChatPanel so the composer/popover can consume it without threading a
 * dozen individual props through the panel itself.
 */
export function useContextFiles() {
  const [useNoteContext, setUseNoteContext] = useState(
    () => localStorage.getItem("pref:aiChatUseNoteContext") !== "false",
  );

  // Open note/file tabs — the pool the context picker chooses from.
  const noteTabs = useAppStore(useShallow((s) => s.tabs.filter((t) => t.kind === "note")));

  // Which open tabs are included as chat context. Seeded to just the active
  // tab (matches the old single-file behavior); reset on New chat/load chat,
  // not persisted — a stale tab-id list from a past session is meaningless.
  const [contextTabIds, setContextTabIds] = useState<Set<string>>(seedContextTabIds);
  const [ctxPopoverOpen, setCtxPopoverOpen] = useState(false);
  const ctxPickerBtnRef = useRef<HTMLButtonElement>(null);

  const selectedTabs = useMemo(
    () => noteTabs.filter((t) => contextTabIds.has(t.id)),
    [noteTabs, contextTabIds],
  );

  const toggleNoteContext = useCallback(() => {
    setUseNoteContext((v) => {
      const next = !v;
      localStorage.setItem("pref:aiChatUseNoteContext", String(next));
      return next;
    });
  }, []);

  const toggleContextTab = useCallback((id: string) => {
    setContextTabIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAllContext = useCallback(() => {
    setContextTabIds(new Set(noteTabs.map((t) => t.id)));
  }, [noteTabs]);

  const clearAllContext = useCallback(() => setContextTabIds(new Set()), []);

  // Reset to the default single-active-tab selection — used by New chat / Load chat.
  const resetContextTabs = useCallback(() => setContextTabIds(seedContextTabIds()), []);

  return {
    useNoteContext, toggleNoteContext,
    noteTabs, contextTabIds, selectedTabs,
    toggleContextTab, selectAllContext, clearAllContext, resetContextTabs,
    ctxPopoverOpen, setCtxPopoverOpen, ctxPickerBtnRef,
  };
}
