import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { useAppStore } from "../store";
import { bootstrapAutostart } from "../lib/autostart";
import { isTourCompleted, wasUpdated, recordSeenVersion } from "../lib/firstRun";
import { readFileEntry, type FileEntry } from "../lib/fileOps";
import { WHATS_NEW } from "../config/whatsNew";
import { APP_VERSION } from "../config/app";
import { updater } from "../lib/updater";
import { canAutoCheck, UPDATE_CHECK_INTERVAL_MS } from "../lib/updateSchedule";
import { OPEN_SETTINGS_EVENT, RUN_AI_ONBOARDING_EVENT, parseOpenSettingsDetail } from "../lib/settingsEvents";

interface Options {
  setShowTour:     (show: boolean) => void;
  setShowAIOnboarding: (show: boolean) => void;
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
  setShowTour, setShowAIOnboarding, setShowPalette, setShowSearch,
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

  // Auto-check for app updates shortly after startup and then every hour (toggle in
  // Settings → About) — the app can stay in the tray for days. No-ops outside Tauri;
  // if an update exists the topbar pill appears.
  useEffect(() => {
    if (!autoUpdateCheck) return;
    const run = () => { if (canAutoCheck(updater.getState().status)) void updater.check({ silent: true }); };
    const t = setTimeout(run, 3000);
    const every = setInterval(run, UPDATE_CHECK_INTERVAL_MS);
    return () => { clearTimeout(t); clearInterval(every); };
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
        openFilesAsTabs([await readFileEntry(filePath)]);
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
            entries.push(await readFileEntry(filePath));
          } catch { /* skip unreadable / binary */ }
        }
        if (entries.length) openFilesAsTabs(entries);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []); // Init-once: drag-drop listener registered at mount

  // Open the command palette / global search from the Monaco editor (which
  // swallows Ctrl+Shift+P / Ctrl+Shift+F internally and re-dispatches them as
  // events), replay the tour / What's New entry points from Settings → General,
  // open the Settings tab (`app:open-settings`, optional section / setting
  // deep link) and re-run the AI onboarding wizard (Settings → AI).
  useEffect(() => {
    const openPalette = () => setShowPalette(true);
    const openSearch = () => setShowSearch(true);
    // Settings is a tab, so nothing has to be closed before the tour or the note shows.
    const startTour = () => setShowTour(true);
    const showWhatsNew = () => openWhatsNew();
    const runAIOnboarding = () => setShowAIOnboarding(true);
    const openSettingsTab = (e: Event) => {
      const { section, settingId } = parseOpenSettingsDetail((e as CustomEvent).detail);
      useAppStore.getState().openSettings(section, settingId);
    };
    window.addEventListener("app:command-palette", openPalette);
    window.addEventListener("app:global-search", openSearch);
    window.addEventListener("app:start-tour", startTour);
    window.addEventListener("app:show-whats-new", showWhatsNew);
    window.addEventListener(RUN_AI_ONBOARDING_EVENT, runAIOnboarding);
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettingsTab);
    return () => {
      window.removeEventListener("app:command-palette", openPalette);
      window.removeEventListener("app:global-search", openSearch);
      window.removeEventListener("app:start-tour", startTour);
      window.removeEventListener("app:show-whats-new", showWhatsNew);
      window.removeEventListener(RUN_AI_ONBOARDING_EVENT, runAIOnboarding);
      window.removeEventListener(OPEN_SETTINGS_EVENT, openSettingsTab);
    };
  }, [openWhatsNew]);

  return { dragOver };
}
