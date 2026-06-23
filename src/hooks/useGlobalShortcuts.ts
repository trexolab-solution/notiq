import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { exportToPDF } from "../lib/pdfExport";

interface Options {
  requestClose:        (id: string) => void;
  handleOpenMultiple:  () => void;
  handleOpenFolder:    () => void;
  handleNewWhiteboard: () => void;
  onOpenSettings:      () => void;
  onOpenCommandPalette: () => void;
}

export function useGlobalShortcuts(opts: Options) {
  const tabs            = useAppStore((s) => s.tabs);
  const activeTabId     = useAppStore((s) => s.activeTabId);
  const addTab          = useAppStore((s) => s.addTab);
  const setActiveTab    = useAppStore((s) => s.setActiveTab);
  const saveTabToFile   = useAppStore((s) => s.saveTabToFile);
  const saveTabToFileAs = useAppStore((s) => s.saveTabToFileAs);

  // Keep latest values in a ref so the event listener doesn't need to be
  // re-registered every time a dependency changes.
  const ref = useRef({
    tabs, activeTabId, addTab, setActiveTab,
    saveTabToFile, saveTabToFileAs, ...opts,
  });
  ref.current = {
    tabs, activeTabId, addTab, setActiveTab,
    saveTabToFile, saveTabToFileAs, ...opts,
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const {
        tabs, activeTabId, addTab, setActiveTab,
        saveTabToFile, saveTabToFileAs,
        requestClose, handleOpenMultiple, handleOpenFolder, handleNewWhiteboard, onOpenSettings,
        onOpenCommandPalette,
      } = ref.current;
      const activeTab = tabs.find((t) => t.id === activeTabId);

      // Ctrl+Shift+P → command palette (also prevents the native print dialog)
      if (e.ctrlKey && e.shiftKey && (e.key === "P" || e.key === "p")) { e.preventDefault(); onOpenCommandPalette(); return; }
      if (e.ctrlKey && !e.shiftKey && e.key === "n") { e.preventDefault(); addTab(); return; }
      if (e.ctrlKey && !e.shiftKey && e.key === "w") { e.preventDefault(); if (activeTabId) requestClose(activeTabId); return; }
      if (e.ctrlKey && !e.shiftKey && e.key === "s") {
        e.preventDefault();
        if (activeTabId && activeTab?.kind !== "whiteboard") saveTabToFile(activeTabId);
        return;
      }
      if (e.ctrlKey && e.shiftKey && e.key === "S") {
        e.preventDefault();
        if (activeTabId && activeTab?.kind !== "whiteboard") saveTabToFileAs(activeTabId);
        return;
      }
      if (e.ctrlKey && !e.shiftKey && e.key === "o") { e.preventDefault(); handleOpenMultiple(); return; }
      if (e.ctrlKey && e.shiftKey  && e.key === "O") { e.preventDefault(); handleOpenFolder();   return; }
      if (e.ctrlKey && !e.shiftKey && e.key === "p") {
        e.preventDefault();
        if (activeTab?.kind === "note") exportToPDF(activeTab.title, activeTab.content).catch(console.error);
        return;
      }
      if (e.ctrlKey && !e.shiftKey && e.key === "3") { e.preventDefault(); handleNewWhiteboard(); return; }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key) - 1;
        if (idx < tabs.length) { e.preventDefault(); setActiveTab(tabs[idx].id); }
        return;
      }
      if (e.ctrlKey && !e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        if (tabs.length < 2) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        setActiveTab(tabs[(idx + 1) % tabs.length].id);
        return;
      }
      if (e.ctrlKey && e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        if (tabs.length < 2) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
        return;
      }
      if (e.ctrlKey && e.key === ",") { e.preventDefault(); onOpenSettings(); }
    };

    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []); // Init-once: reads from ref.current for all dependencies
}
