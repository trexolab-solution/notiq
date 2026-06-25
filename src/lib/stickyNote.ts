import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useStickyNotesStore } from "../store/stickyNoteStore";

/** Window options for a sticky-note webview (shared by the create + retry paths). */
function stickyNoteWindowOptions(id: string) {
  return {
    url: `index.html#/sticky-note/${id}`,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    width: 380,
    height: 450,
    minWidth: 280,
    minHeight: 200,
    visible: false,
    shadow: false,
    resizable: true,
    title: "Sticky Note",
  };
}

export async function openStickyNote(noteId?: string) {
  // If a specific note ID is given, try to focus its existing window
  if (noteId) {
    try {
      const existing = await WebviewWindow.getByLabel(`sticky-note-${noteId}`);
      if (existing) {
        await existing.setFocus();
        return;
      }
    } catch {
      // Window reference may be stale (destroyed but not cleaned up) —
      // fall through and create a fresh window.
    }
  }

  // Create a new note in the store (or reuse given ID)
  const id = noteId ?? useStickyNotesStore.getState().createNote();

  // Track as open
  useStickyNotesStore.getState().addOpenWindow(id);

  try {
    new WebviewWindow(`sticky-note-${id}`, stickyNoteWindowOptions(id));
  } catch {
    // Label might already exist from a stale window — destroy it and retry
    try {
      const stale = await WebviewWindow.getByLabel(`sticky-note-${id}`);
      if (stale) await stale.destroy();
      new WebviewWindow(`sticky-note-${id}`, stickyNoteWindowOptions(id));
    } catch (e) {
      console.error("sticky-note: failed to create window", e);
    }
  }
}

/** Open the Sticky Notes list window (or focus it if already open). */
export async function openStickyNotesList() {
  const existing = await WebviewWindow.getByLabel("sticky-notes-list");
  if (existing) {
    await existing.setFocus();
    return;
  }

  new WebviewWindow("sticky-notes-list", {
    url: "index.html#/sticky-notes-list",
    decorations: false,
    transparent: true,
    skipTaskbar: true,
    width: 340,
    height: 480,
    minWidth: 280,
    minHeight: 300,
    visible: false,
    shadow: false,
    resizable: true,
    title: "Sticky Notes",
  });
}

/** Re-open all sticky note windows that were open in the previous session. */
export function restoreStickyNotes() {
  const { openWindowIds, notes } = useStickyNotesStore.getState();
  for (const id of openWindowIds) {
    // Only restore if the note data still exists
    if (notes[id]) {
      openStickyNote(id);
    }
  }
}
