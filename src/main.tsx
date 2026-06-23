import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./lib/monacoWorkers"; // must be imported before any Monaco editor renders
import "./App.css"; // load CSS synchronously for all windows (main + sticky notes)

const hash = window.location.hash;
const isStickyNote = hash.startsWith("#/sticky-note/");
const isStickyNotesList = hash === "#/sticky-notes-list";

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
} else {
  // ── Main app window ───────────────────────────────────────────────────────
  import("./mainApp").then((m) => m.initMainApp());
}
