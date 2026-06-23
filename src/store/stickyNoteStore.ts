import { create } from "zustand";

const STORAGE_KEY = "sticky-notes:state";
const OPEN_KEY    = "sticky-notes:open";

export interface StickyNoteData {
  id: string;
  content: string;
  language: string;
  bgColor: string;
  alwaysOnTop: boolean;
  fontSize: number;
  unfocusedOpacity: number;
  createdAt: number;
  updatedAt: number;
}

interface StickyNotesState {
  notes: Record<string, StickyNoteData>;
  openWindowIds: string[];

  createNote: () => string;
  deleteNote: (id: string) => void;
  getNote: (id: string) => StickyNoteData;
  updateNote: (id: string, patch: Partial<Omit<StickyNoteData, "id">>) => void;
  addOpenWindow: (id: string) => void;
  removeOpenWindow: (id: string) => void;
  /** Return all notes sorted by most recently updated. */
  getAllNotes: () => StickyNoteData[];
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function defaultNote(id: string): StickyNoteData {
  const now = Date.now();
  return {
    id,
    content: "",
    language: "markdown",
    bgColor: "",
    alwaysOnTop: true,
    fontSize: 14,
    unfocusedOpacity: 0.85,
    createdAt: now,
    updatedAt: now,
  };
}

function isValidNoteRecord(obj: unknown): obj is Record<string, StickyNoteData> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  for (const val of Object.values(obj)) {
    if (!val || typeof val !== "object" || typeof (val as StickyNoteData).id !== "string") return false;
  }
  return true;
}

function loadNotes(): Record<string, StickyNoteData> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Single-note legacy format (object with "content" but no "id" at root)
      if (parsed && typeof parsed === "object" && !parsed.id && "content" in parsed) {
        const id = newId();
        return { [id]: { ...defaultNote(id), ...parsed } };
      }
      if (isValidNoteRecord(parsed)) return parsed;
      // Corrupted data — fall through to empty
      console.warn("sticky-notes: invalid data format, resetting");
      return {};
    }
    const oldRaw = localStorage.getItem("sticky-note:state");
    if (oldRaw) {
      const old = JSON.parse(oldRaw);
      if (old && typeof old === "object") {
        const id = newId();
        localStorage.removeItem("sticky-note:state");
        const notes = { [id]: { ...defaultNote(id), ...old, id } };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
        return notes;
      }
    }
  } catch (e) {
    console.warn("sticky-notes: failed to load data", e);
  }
  return {};
}

function loadOpenIds(): string[] {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function persistNotes(notes: Record<string, StickyNoteData>) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    } catch (e) {
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        console.error("sticky-notes: localStorage quota exceeded — notes may not be saved!", e);
      } else {
        console.warn("sticky-notes: failed to persist", e);
      }
    }
  }, 300);
}

function persistOpen(ids: string[]) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(ids));
  } catch { /* best-effort */ }
}

export const useStickyNotesStore = create<StickyNotesState>((set, get) => ({
  notes: loadNotes(),
  openWindowIds: loadOpenIds(),

  createNote() {
    const id = newId();
    const note = defaultNote(id);
    set((s) => {
      const notes = { ...s.notes, [id]: note };
      persistNotes(notes);
      return { notes };
    });
    return id;
  },

  deleteNote(id) {
    set((s) => {
      const { [id]: _, ...rest } = s.notes;
      persistNotes(rest);
      return { notes: rest };
    });
  },

  getNote(id) {
    return get().notes[id] ?? defaultNote(id);
  },

  updateNote(id, patch) {
    set((s) => {
      const existing = s.notes[id] ?? defaultNote(id);
      const notes = { ...s.notes, [id]: { ...existing, ...patch, updatedAt: Date.now() } };
      persistNotes(notes);
      return { notes };
    });
  },

  getAllNotes() {
    const notes = get().notes;
    return Object.values(notes).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },

  addOpenWindow(id) {
    set((s) => {
      if (s.openWindowIds.includes(id)) return s;
      const openWindowIds = [...s.openWindowIds, id];
      persistOpen(openWindowIds);
      return { openWindowIds };
    });
  },

  removeOpenWindow(id) {
    set((s) => {
      const openWindowIds = s.openWindowIds.filter((x) => x !== id);
      persistOpen(openWindowIds);
      return { openWindowIds };
    });
  },
}));
