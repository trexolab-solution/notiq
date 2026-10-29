import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./lib/monacoWorkers"; // must be imported before any Monaco editor renders
import "./App.css"; // load CSS synchronously for all windows (main + sticky notes)

const hash = window.location.hash;
const isStickyNote = hash.startsWith("#/sticky-note/");
const isStickyNotesList = hash === "#/sticky-notes-list";
const isQuickSearch = hash === "#/quick-search"; // 0.7.0 quick search

if (isStickyNote) {
  // ── Sticky Note window ────────────────────────────────────────────────────
  const StickyNoteApp = lazy(() => import("./components/sticky-note/StickyNoteApp"));

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Suspense fallback={null}>
        <StickyNoteApp />
      </Suspense>
    </React.StrictMode>,
  );
} else if (isStickyNotesList) {
  // ── Sticky Notes List window ──────────────────────────────────────────────
  const StickyNotesListApp = lazy(() => import("./components/sticky-note/StickyNotesListApp"));

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Suspense fallback={null}>
        <StickyNotesListApp />
      </Suspense>
    </React.StrictMode>,
  );
} else if (isQuickSearch) {
  // ── Quick search popup (0.7.0, opened by the global hotkey) ──────────────
  const QuickSearchApp = lazy(() => import("./quick/QuickSearchApp"));

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Suspense fallback={null}>
        <QuickSearchApp />
      </Suspense>
    </React.StrictMode>,
  );
} else {
  // ── Main app window ───────────────────────────────────────────────────────
  import("./mainApp").then((m) => m.initMainApp());
  import("./quick/quickSearch").then((m) => m.initQuickSearchBridge()); // 0.7.0 quick search
}
