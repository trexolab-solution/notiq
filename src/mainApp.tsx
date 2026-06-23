import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib/tauriWindow";
import { restoreStateCurrent, StateFlags } from "@tauri-apps/plugin-window-state";
import { useAppStore } from "./store";
import { openStickyNote, openStickyNotesList } from "./lib/stickyNote";
import { listen } from "@tauri-apps/api/event";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { getFileName } from "./lib/pathUtils";

export function initMainApp() {
  // Listen for "New Sticky Note" from tray menu — registered early so no
  // events are lost while the session is still hydrating.
  listen("open-sticky-note", () => { openStickyNote(); })
    .catch((e) => console.warn("Failed to listen for open-sticky-note:", e));

  // Listen for "Sticky Notes" list from tray menu
  listen("open-sticky-notes-list", () => { openStickyNotesList(); })
    .catch((e) => console.warn("Failed to listen for open-sticky-notes-list:", e));

  // Listen for file opened from a second instance (file association while running)
  listen<string>("open-file", async (event) => {
    const filePath = event.payload;
    if (!filePath) return;
    try {
      const content = await readTextFile(filePath);
      const name = getFileName(filePath) || "Note";
      const title = name.replace(/\.(md|markdown|txt|notiq)$/i, "");
      useAppStore.getState().openFilesAsTabs([{ path: filePath, content, title }]);
    } catch { /* file unreadable — ignore */ }
  }).catch((e) => console.warn("Failed to listen for open-file:", e));

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  // Show the window only after the session has fully hydrated from IndexedDB.
  // The window starts hidden (visible: false in tauri.conf.json) so the user
  // never sees a flash of empty state — the window appears already populated.
  // We subscribe to sessionReady, then use two rAFs to guarantee the browser
  // has committed the painted frame to screen before making it visible.
  function showWindowWhenReady() {
    requestAnimationFrame(() =>
      requestAnimationFrame(async () => {
        if (isTauri) {
          try {
            await restoreStateCurrent(
              StateFlags.SIZE | StateFlags.POSITION | StateFlags.MAXIMIZED,
            );
          } catch {
            // First launch (no saved state yet) or running outside Tauri — ignore.
          }
        }
        invoke("show_main_window").catch(() => {
          // Not running inside Tauri (e.g. plain browser dev) — ignore.
        });
        // Sticky notes are no longer auto-restored on launch;
        // the user opens them manually from the sticky notes list.
      }),
    );
  }

  if (useAppStore.getState().sessionReady) {
    showWindowWhenReady();
  } else {
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      unsub();
      clearTimeout(safetyTimer);
      showWindowWhenReady();
    };
    const unsub = useAppStore.subscribe((state) => {
      if (state.sessionReady) show();
    });
    // Safety net: show the window after 6 s even if sessionReady never fires
    // (the Rust side has its own 8 s fallback, but this cleans up the subscription)
    const safetyTimer = setTimeout(show, 6000);
  }
}
