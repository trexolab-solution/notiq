import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Plus, Trash2, X, Search, FileText, StickyNote, Check, ExternalLink } from "lucide-react";
import logoUrl from "../../assets/logo.png";
import { applyTheme } from "../../lib/themes";
import { useStickyNotesStore, type StickyNoteData } from "../../store/stickyNoteStore";
import { openStickyNote } from "../../lib/stickyNote";

const NOTE_DOT_COLORS: Record<string, string> = {
  "#fffde7": "#f59e0b",
  "#e8f5e9": "#22c55e",
  "#e3f2fd": "#3b82f6",
  "#fce4ec": "#ec4899",
  "#f3e5f5": "#a855f7",
  "#fff3e0": "#f97316",
};

function formatDate(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  if (isToday) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isYesterday) return "Yesterday";
  if (now.getFullYear() === d.getFullYear()) {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function noteTitle(note: StickyNoteData): string {
  const text = note.content.trim();
  if (!text) return "Untitled Note";
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const clean = first.replace(/^#+\s*/, "").replace(/^[-*>]\s*/, "").trim();
  return clean.length > 50 ? clean.slice(0, 50) + "\u2026" : clean || "Untitled Note";
}

function notePreview(note: StickyNoteData): string {
  const lines = note.content.trim().split("\n").filter((l) => l.trim());
  if (lines.length <= 1) return "No additional text";
  const body = lines
    .slice(1, 3)
    .map((l) => l.replace(/^#+\s*/, "").replace(/^[-*>]\s*/, "").trim())
    .join(" — ");
  return body.length > 90 ? body.slice(0, 90) + "\u2026" : body;
}

export default function StickyNotesListApp() {
  const notes = useStickyNotesStore((s) => s.notes);
  const openWindowIds = useStickyNotesStore((s) => s.openWindowIds);
  const deleteNote = useStickyNotesStore((s) => s.deleteNote);

  const [search, setSearch] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Auto-reset delete confirmation after 3 seconds
  useEffect(() => {
    if (!deleteId) return;
    const timer = setTimeout(() => setDeleteId(null), 3000);
    return () => clearTimeout(timer);
  }, [deleteId]);

  // Disable native context menu + mark as sticky note window + apply initial theme
  useEffect(() => {
    document.documentElement.classList.add("is-sticky-note");
    const savedTheme = localStorage.getItem("pref:theme") || "dark";
    applyTheme(savedTheme as Parameters<typeof applyTheme>[0]);
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  // Live theme sync
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ themeId: string }>("theme-changed", (e) => {
      const id = e.payload.themeId;
      applyTheme(id as Parameters<typeof applyTheme>[0]);
    }).then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  // Show window after first paint
  useEffect(() => {
    const win = getCurrentWindow();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        win.show().catch(() => {});
        win.setShadow(true).catch(() => {});
      }),
    );
  }, []);

  // Ctrl+F to focus search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleDrag = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (e.buttons !== 1) return;
    const el = e.target as HTMLElement;
    if (el.closest("button, input")) return;
    getCurrentWindow().startDragging();
  }, []);

  const handleClose = useCallback(() => getCurrentWindow().destroy(), []);
  const handleNew = useCallback(() => openStickyNote(), []);
  const handleOpen = useCallback((id: string) => {
    setDeleteId(null);
    openStickyNote(id);
  }, []);
  const handleDelete = useCallback((id: string) => {
    deleteNote(id);
    setDeleteId(null);
  }, [deleteNote]);

  const sorted = useMemo(() => {
    const all = Object.values(notes).sort(
      (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0),
    );
    if (!search.trim()) return all;
    const q = search.toLowerCase();
    return all.filter((n) => n.content.toLowerCase().includes(q));
  }, [notes, search]);

  const total = Object.keys(notes).length;

  return (
    <div className="snl">

      {/* ── Titlebar — matches app-header pattern ── */}
      <header className="snl-header" onMouseDown={handleDrag}>
        <div className="snl-brand">
          <img src={logoUrl} alt="" draggable={false} className="snl-brand__logo" />
          <span className="snl-brand__name">Sticky Notes</span>
        </div>
        <div className="snl-header__actions">
          <button className="snl-icon-btn" onClick={handleNew} title="New Note" aria-label="New Note">
            <Plus size={15} strokeWidth={2} />
          </button>
          <button className="snl-icon-btn snl-icon-btn--close" onClick={handleClose} title="Close" aria-label="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      </header>

      {/* ── Search bar ── */}
      <div className="snl-searchbar">
        <Search size={13} strokeWidth={1.6} className="snl-searchbar__icon" />
        <input
          ref={searchRef}
          className="snl-searchbar__input"
          type="text"
          placeholder="Search notes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
        {search && (
          <button className="snl-searchbar__clear" onClick={() => setSearch("")} aria-label="Clear search">
            <X size={11} strokeWidth={2.5} />
          </button>
        )}
        {total > 0 && (
          <span className="snl-searchbar__count">
            {search ? `${sorted.length}/${total}` : total}
          </span>
        )}
      </div>

      {/* ── Notes list ── */}
      <div className="snl-list">
        {sorted.length === 0 ? (
          <div className="snl-empty">
            <div className="snl-empty__icon">
              <StickyNote size={42} strokeWidth={0.8} />
            </div>
            {search ? (
              <>
                <p className="snl-empty__title">No results</p>
                <p className="snl-empty__desc">
                  Nothing matches &ldquo;{search.length > 25 ? search.slice(0, 25) + "\u2026" : search}&rdquo;
                </p>
              </>
            ) : (
              <>
                <p className="snl-empty__title">No sticky notes</p>
                <p className="snl-empty__desc">Quick notes that float on your desktop</p>
                <button className="snl-empty__cta" onClick={handleNew}>
                  <Plus size={13} strokeWidth={2.5} />
                  <span>New Note</span>
                </button>
              </>
            )}
          </div>
        ) : (
          sorted.map((note) => {
            const isOpen = openWindowIds.includes(note.id);
            const isDeleting = deleteId === note.id;
            const dotColor = NOTE_DOT_COLORS[note.bgColor] || undefined;

            return (
              <div
                key={note.id}
                className={`snl-row${isOpen ? " is-active" : ""}`}
              >
                {/* Color dot */}
                <span
                  className="snl-row__dot"
                  style={dotColor ? { background: dotColor } : undefined}
                />

                {/* Note info */}
                <div className="snl-row__body">
                  <span className="snl-row__title">{noteTitle(note)}</span>
                  <div className="snl-row__sub">
                    <span className="snl-row__date">{formatDate(note.updatedAt || note.createdAt)}</span>
                    <span className="snl-row__preview">{notePreview(note)}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="snl-row__actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="snl-row__open"
                    onClick={() => handleOpen(note.id)}
                    aria-label="Open note"
                  >
                    <ExternalLink size={13} strokeWidth={1.6} />
                  </button>
                  <button
                    className={`snl-row__delete${isDeleting ? " is-confirming" : ""}`}
                    onClick={() => isDeleting ? handleDelete(note.id) : setDeleteId(note.id)}
                    aria-label={isDeleting ? "Confirm delete" : "Delete note"}
                  >
                    {isDeleting
                      ? <Check size={13} strokeWidth={2.5} />
                      : <Trash2 size={13} strokeWidth={1.6} />}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Status bar — matches app StatusBar ── */}
      {total > 0 && (
        <div className="snl-status">
          <FileText size={11} strokeWidth={1.6} />
          <span>{search ? `${sorted.length} of ${total} notes` : `${total} note${total !== 1 ? "s" : ""}`}</span>
        </div>
      )}
    </div>
  );
}
