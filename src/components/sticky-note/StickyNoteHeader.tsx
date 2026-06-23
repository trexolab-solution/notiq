import { useState, useRef, useCallback } from "react";
import { useClickOutside } from "../../hooks/useClickOutside";
import {
  Plus, Pin, PinOff, X, Ellipsis, ChevronRight, Check, Save,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useStickyNotesStore } from "../../store/stickyNoteStore";
import { openStickyNote } from "../../lib/stickyNote";
import { Tooltip } from "../ui/Tooltip";

const LANGUAGES = [
  { id: "markdown",   label: "Markdown" },
  { id: "plaintext",  label: "Plain Text" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "python",     label: "Python" },
  { id: "json",       label: "JSON" },
  { id: "html",       label: "HTML" },
  { id: "css",        label: "CSS" },
  { id: "sql",        label: "SQL" },
  { id: "rust",       label: "Rust" },
  { id: "go",         label: "Go" },
  { id: "java",       label: "Java" },
  { id: "cpp",        label: "C++" },
  { id: "shell",      label: "Shell" },
  { id: "yaml",       label: "YAML" },
];

const COLOR_SWATCHES = [
  // Light — inspired by Windows Sticky Notes & Google Keep
  { color: "#fff9b1", label: "Yellow" },
  { color: "#f28b82", label: "Coral" },
  { color: "#aecbfa", label: "Blue" },
  { color: "#ccff90", label: "Lime" },
  { color: "#d7aefb", label: "Purple" },
  { color: "#fdcfe8", label: "Pink" },
  { color: "#a7ffeb", label: "Teal" },
  { color: "#cbf0f8", label: "Ice" },
  { color: "#e6c9a8", label: "Sand" },
  { color: "#e8eaed", label: "Silver" },
  { color: "#f5c469", label: "Amber" },
  { color: "#b4ddd4", label: "Sage" },
  // Dark
  { color: "#3b3a30", label: "Olive" },
  { color: "#442a2a", label: "Maroon" },
  { color: "#2a3142", label: "Navy" },
  { color: "#2a3a2e", label: "Forest" },
  { color: "#362b42", label: "Grape" },
  { color: "#3a3232", label: "Cocoa" },
];

interface Props {
  noteId: string;
}

export function StickyNoteHeader({ noteId }: Props) {
  const note       = useStickyNotesStore((s) => s.notes[noteId]);
  const updateNote = useStickyNotesStore((s) => s.updateNote);

  const language         = note?.language ?? "markdown";
  const bgColor          = note?.bgColor ?? "";
  const alwaysOnTop      = note?.alwaysOnTop ?? true;
  const unfocusedOpacity = note?.unfocusedOpacity ?? 0.5;

  const [menuOpen, setMenuOpen]   = useState(false);
  const [langOpen, setLangOpen]   = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);

  const isCustomColor = bgColor !== "" && !COLOR_SWATCHES.some((s) => s.color === bgColor);

  const onCustomColor = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNote(noteId, { bgColor: e.target.value });
    },
    [noteId, updateNote],
  );

  // Close menu on outside click
  useClickOutside(menuRef, () => { setMenuOpen(false); setLangOpen(false); }, menuOpen);

  const togglePin = async () => {
    const next = !alwaysOnTop;
    updateNote(noteId, { alwaysOnTop: next });
    await getCurrentWindow().setAlwaysOnTop(next);
  };

  const handleSave = useCallback(async () => {
    const content = note?.content ?? "";
    const ext = language === "markdown" ? "md" : language === "plaintext" ? "txt" : language;
    const result = await save({
      filters: [
        { name: "Text / Markdown", extensions: ["md", "txt"] },
        { name: "All Files", extensions: ["*"] },
      ],
      defaultPath: `sticky-note.${ext}`,
    });
    if (!result) return;
    await writeTextFile(result, content);
  }, [note?.content, language]);

  const currentLang = LANGUAGES.find((l) => l.id === language) ?? LANGUAGES[0];

  return (
    <div className="sn-bar">
      {/* Left — menu + pin */}
      <div className="sn-bar-left">
        <div className="sn-bar-side" ref={menuRef}>
          <Tooltip content="Menu" delay={300} disabled={menuOpen}>
            <button
              className={`sn-bar-btn${menuOpen ? " is-open" : ""}`}
              onClick={() => { setMenuOpen((v) => !v); setLangOpen(false); }}
            >
              <Ellipsis size={15} strokeWidth={2} />
            </button>
          </Tooltip>

          {menuOpen && (
            <div className="sn-menu">
              {/* Language sub-menu */}
            <div className="sn-submenu-wrap">
              <button
                className="sn-menu-item"
                onClick={() => setLangOpen((v) => !v)}
              >
                <span className="sn-menu-lang-badge">{currentLang.label}</span>
                <ChevronRight size={13} strokeWidth={1.8} className="sn-menu-chevron" />
              </button>
              {langOpen && (
                <div className="sn-submenu">
                  {LANGUAGES.map((l) => (
                    <button
                      key={l.id}
                      className={`sn-submenu-item${l.id === language ? " is-active" : ""}`}
                      onClick={() => {
                        updateNote(noteId, { language: l.id });
                        setLangOpen(false);
                        setMenuOpen(false);
                      }}
                    >
                      <span>{l.label}</span>
                      {l.id === language && <Check size={13} strokeWidth={2} />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="sn-menu-sep" />

            {/* Colors */}
            <div className="sn-menu-section-label">Background</div>
            <div className="sn-color-grid">
              <button
                className={`sn-color-swatch sn-color-reset${bgColor === "" ? " is-active" : ""}`}
                onClick={() => updateNote(noteId, { bgColor: "" })}
                title="Theme default"
              >
                <span>Auto</span>
              </button>
              {COLOR_SWATCHES.map((s) => (
                <button
                  key={s.color}
                  className={`sn-color-swatch${bgColor === s.color ? " is-active" : ""}`}
                  style={{ background: s.color }}
                  onClick={() => updateNote(noteId, { bgColor: s.color })}
                  title={s.label}
                />
              ))}
              {/* Custom color picker */}
              <button
                className={`sn-color-swatch sn-color-custom${isCustomColor ? " is-active" : ""}`}
                style={isCustomColor ? { background: bgColor } : {}}
                onClick={() => colorInputRef.current?.click()}
                title="Custom color"
              >
                {!isCustomColor && <span>+</span>}
              </button>
              <input
                ref={colorInputRef}
                type="color"
                value={bgColor || "#ffffff"}
                onChange={onCustomColor}
                className="sn-color-input-hidden"
              />
            </div>

            <div className="sn-menu-sep" />

            {/* Opacity slider */}
            <div className="sn-menu-section-label">Unfocused opacity</div>
            <div className="sn-opacity-row">
              <input
                type="range"
                min="10"
                max="100"
                value={Math.round(unfocusedOpacity * 100)}
                onChange={(e) => updateNote(noteId, { unfocusedOpacity: Number(e.target.value) / 100 })}
                className="sn-opacity-slider"
              />
              <span className="sn-opacity-value">{Math.round(unfocusedOpacity * 100)}%</span>
            </div>
          </div>
          )}
        </div>

        {/* Pin — always visible, one click */}
        <Tooltip content={alwaysOnTop ? "Unpin from top" : "Pin on top"} delay={300}>
          <button
            className={`sn-bar-btn${alwaysOnTop ? " sn-pin-active" : ""}`}
            onClick={togglePin}
          >
            {alwaysOnTop
              ? <Pin size={13} strokeWidth={2} />
              : <PinOff size={13} strokeWidth={2} />}
          </button>
        </Tooltip>
      </div>

      {/* Right — save + new note + close */}
      <div className="sn-bar-right">
        <Tooltip content="Save as file" delay={300}>
          <button className="sn-bar-btn" onClick={handleSave}>
            <Save size={13} strokeWidth={2} />
          </button>
        </Tooltip>
        <Tooltip content="New Note" delay={300}>
          <button className="sn-bar-btn" onClick={() => openStickyNote()}>
            <Plus size={15} strokeWidth={2} />
          </button>
        </Tooltip>
        <Tooltip content="Close" delay={300}>
          <button
            className="sn-bar-btn sn-bar-close"
            onClick={() => {
              useStickyNotesStore.getState().removeOpenWindow(noteId);
              getCurrentWindow().destroy();
            }}
          >
            <X size={14} strokeWidth={2} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
