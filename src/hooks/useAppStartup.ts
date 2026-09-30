import { useCallback, useEffect, useState } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { useAppStore } from "../store";
import { bootstrapAutostart } from "../lib/autostart";
import { isTourCompleted, wasUpdated, recordSeenVersion } from "../lib/firstRun";
import { getFileName } from "../lib/pathUtils";
import type { FileEntry } from "../lib/fileOps";
import { WHATS_NEW } from "../config/whatsNew";
import { APP_VERSION } from "../config/app";
import { updater } from "../lib/updater";

interface Options {
  setShowTour:     (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  setShowPalette:  (show: boolean) => void;
  setShowSearch:   (show: boolean) => void;
}

export interface AppStartupResult {
  /** True while a file is being dragged over the window (OS drag-and-drop). */
  dragOver: boolean;
}

/**
 * Bundles the "runs once around launch" effects that used to live inline in
 * App: autostart bootstrap, background update check, first-run tour /
 * post-update "What's New" note, opening a file passed via file-association
 * or CLI arg, OS drag-and-drop of files onto the window, and the window
 * CustomEvent bridge the Monaco editor uses to open the command palette /
 * global search (it swallows Ctrl+Shift+P / Ctrl+Shift+F internally and
 * re-dispatches them as events) and to replay the tour / What's New entry
 * points from Settings → General.
 *
 * Effects below are declared in the same order App previously declared them
 * in, so listener/timer registration order is unchanged.
 */
export function useAppStartup({
  setShowTour, setShowSettings, setShowPalette, setShowSearch,
}: Options): AppStartupResult {
  const addTab          = useAppStore((s) => s.addTab);
  const openFilesAsTabs = useAppStore((s) => s.openFilesAsTabs);
  const autoUpdateCheck = useAppStore((s) => s.autoUpdateCheck);

  // Open the "What's New" release note as an in-memory preview tab.
  const openWhatsNew = useCallback(() => {
    addTab({
      kind: "note",
      title: `What's New in Notiq ${APP_VERSION}`,
      content: WHATS_NEW,
      editorMode: "preview",
    });
  }, [addTab]);

  // Bootstrap auto-start on the very first launch of an installed build.
  useEffect(() => { bootstrapAutostart(); }, []);

  // Auto-check for app updates shortly after startup (toggle in Settings →
  // About). No-ops outside Tauri; if an update exists the topbar pill appears.
  useEffect(() => {
    if (!autoUpdateCheck) return;
    const t = setTimeout(() => { void updater.check({ silent: true }); }, 3000);
    return () => clearTimeout(t);
  }, [autoUpdateCheck]);

  // First-run welcome tour + post-update "What's New" note. Both gate on
  // standalone localStorage flags (lib/firstRun) so a preferences reset won't
  // re-trigger them. At most one greets the user per launch: a fresh install
  // gets the tour (and silently records the version); an update opens the note.
  useEffect(() => {
    if (!isTourCompleted()) setShowTour(true);
    else if (wasUpdated(APP_VERSION)) openWhatsNew();
    recordSeenVersion(APP_VERSION);
  }, [openWhatsNew]); // effectively run-once (openWhatsNew is stable)

  // On startup: open file passed via file-association / CLI arg
  useEffect(() => {
    invoke<string | null>("get_open_file").then(async (filePath) => {
      if (!filePath) return;
      try {
        const content = await readTextFile(filePath);
        const name = getFileName(filePath) || "Note";
        const title = name.replace(/\.(md|markdown|txt|notiq)$/i, "");
        openFilesAsTabs([{ path: filePath, content, title }]);
      } catch { /* file unreadable — ignore */ }
    });
  }, []); // Init-once: reads from store via openFilesAsTabs (stable ref)

  // Drag-and-drop files from OS — uses Tauri's native webview drop event
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === "enter") {
        setDragOver(true);
      } else if (event.payload.type === "leave") {
        setDragOver(false);
      } else if (event.payload.type === "drop") {
        setDragOver(false);
        const entries: FileEntry[] = [];
        for (const filePath of event.payload.paths) {
          try {
            const content = await readTextFile(filePath);
            const name = getFileName(filePath) || "Note";
            const title = name.replace(/\.(md|markdown|txt|notiq)$/i, "");
            entries.push({ path: filePath.replace(/\\/g, "/"), content, title });
          } catch { /* skip unreadable / binary */ }
        }
        if (entries.length) openFilesAsTabs(entries);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []); // Init-once: drag-drop listener registered at mount

  // Open the command palette / global search from the Monaco editor (which
  // swallows Ctrl+Shift+P / Ctrl+Shift+F internally and re-dispatches them as
  // events), and replay the tour / What's New entry points from Settings →
  // General.
  useEffect(() => {
    const openPalette = () => setShowPalette(true);
    const openSearch = () => setShowSearch(true);
    // Replay entry points from Settings → General. Close settings first so the
    // tour/note isn't hidden behind the settings modal.
    const startTour = () => { setShowSettings(false); setShowTour(true); };
    const showWhatsNew = () => { setShowSettings(false); openWhatsNew(); };
    window.addEventListener("app:command-palette", openPalette);
    window.addEventListener("app:global-search", openSearch);
    window.addEventListener("app:start-tour", startTour);
    window.addEventListener("app:show-whats-new", showWhatsNew);
    return () => {
      window.removeEventListener("app:command-palette", openPalette);
      window.removeEventListener("app:global-search", openSearch);
      window.removeEventListener("app:start-tour", startTour);
      window.removeEventListener("app:show-whats-new", showWhatsNew);
    };
  }, [openWhatsNew]);

  return { dragOver };
}
