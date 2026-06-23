import { useCallback, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { ArrowLeft, FileText, Plus } from "lucide-react";
import { useAppStore } from "../../store";

// ── Branding suppression ──────────────────────────────────────────────────────
const HIDE_BRANDING_CSS = `
  .excalidraw .excalidraw-link,
  .excalidraw a[href*="excalidraw.com"]:not([class*="library"]),
  .excalidraw .welcome-screen-center__logo,
  .excalidraw .welcome-screen-decor,
  .excalidraw-modal-container a[href*="excalidraw.com"]:not([class*="library"]) {
    display: none !important;
  }
`;

// ── Per-tab persistence ───────────────────────────────────────────────────────
function storageKey(tabId: string) { return `smart-note:wb-${tabId}`; }

function loadState(tabId: string) {
  try {
    const raw = localStorage.getItem(storageKey(tabId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// One debounce timer per tab so concurrent whiteboards don't interfere
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function persistState(tabId: string, elements: unknown, appState: Record<string, unknown>, files: unknown) {
  const existing = saveTimers.get(tabId);
  if (existing) clearTimeout(existing);
  saveTimers.set(tabId, setTimeout(() => {
    saveTimers.delete(tabId);
    try {
      localStorage.setItem(storageKey(tabId), JSON.stringify({
        elements,
        appState: {
          scrollX:             appState.scrollX,
          scrollY:             appState.scrollY,
          zoom:                appState.zoom,
          gridModeEnabled:     appState.gridModeEnabled ?? false,
          viewBackgroundColor: appState.viewBackgroundColor,
        },
        files,
      }));
    } catch (e) {
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        console.warn("Whiteboard: localStorage quota exceeded, data may not be saved");
      }
    }
  }, 600));
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface WhiteboardProps {
  tabId: string;
  linkedNoteId?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function Whiteboard({ tabId, linkedNoteId }: WhiteboardProps) {
  const themeId      = useAppStore((s) => s.themeId);
  const tabs         = useAppStore((s) => s.tabs);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const addTab       = useAppStore((s) => s.addTab);

  const excalidrawTheme = themeId === "light" ? ("light" as const) : ("dark" as const);

  // Loaded once on first render — stable ref prevents Excalidraw from re-initialising
  const initialData = useRef(loadState(tabId));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Excalidraw types are complex, persistence only uses plain serializable data
  const handleChange = useCallback((elements: any, appState: any, files: any) => {
    persistState(tabId, elements, appState, files);
  }, [tabId]);

  const linkedNote = linkedNoteId ? tabs.find((t) => t.id === linkedNoteId) : null;

  return (
    <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
      <style>{HIDE_BRANDING_CSS}</style>

      {/* Excalidraw fills the container */}
      <div style={{ position: "absolute", inset: 0 }}>
        <Excalidraw
          theme={excalidrawTheme}
          initialData={initialData.current}
          onChange={handleChange}
          /*
           * libraryReturnUrl tells Excalidraw where to redirect after a library
           * is selected on libraries.excalidraw.com — enables the built-in
           * "Browse Libraries" button in the toolbar library panel.
           */
          libraryReturnUrl={window.location.origin}
          UIOptions={{
            welcomeScreen: false,
            canvasActions: {
              toggleTheme:     false,
              saveToActiveFile: false,
              loadScene:       false,
            },
          }}
        />
      </div>

      {/* Top-left: create a fresh whiteboard tab (standalone boards only) */}
      {!linkedNoteId && (
        <button
          className="wb-overlay-btn wb-new-btn"
          onClick={() => addTab({ kind: "whiteboard", title: "Whiteboard" })}
          title="Create new whiteboard"
        >
          <Plus size={12} strokeWidth={2.2} />
          <span>New whiteboard</span>
        </button>
      )}

      {/* Overlay: navigate back to linked note (bottom-left, above Excalidraw footer) */}
      {linkedNote && (
        <div className="wb-overlay">
          <button
            className="wb-overlay-btn"
            onClick={() => setActiveTab(linkedNote.id)}
            title={`Open "${linkedNote.title}"`}
          >
            <ArrowLeft size={11} />
            <FileText size={11} />
            <span style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {linkedNote.title}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
