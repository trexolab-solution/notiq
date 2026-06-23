/**
 * Pure data constants used by the settings sections.
 * Kept in a separate file so each section component can pull only the
 * options it needs without dragging in the rest of SettingsModal.
 */

export const FONT_FAMILIES = [
  { label: "JetBrains Mono",  value: "'JetBrains Mono', monospace" },
  { label: "Fira Code",       value: "'Fira Code', monospace" },
  { label: "Cascadia Code",   value: "'Cascadia Code', monospace" },
  { label: "Consolas",        value: "Consolas, monospace" },
  { label: "Courier New",     value: "'Courier New', monospace" },
];

export const EDITOR_MODES: { value: string; label: string }[] = [
  { value: "markdown", label: "Markdown (Source)" },
  { value: "preview",  label: "Preview" },
  { value: "split",    label: "Split (Side-by-Side)" },
];

export const AUTO_CLOSING_OPTIONS = [
  { value: "always",           label: "Always" },
  { value: "beforeWhitespace", label: "Before Whitespace" },
  { value: "never",            label: "Never" },
];

export const RENDER_WHITESPACE_OPTIONS = [
  { value: "none",      label: "None" },
  { value: "boundary",  label: "Boundary" },
  { value: "selection", label: "Selection" },
  { value: "trailing",  label: "Trailing" },
  { value: "all",       label: "All" },
];

export const LINE_HIGHLIGHT_OPTIONS = [
  { value: "none",   label: "None" },
  { value: "gutter", label: "Gutter" },
  { value: "line",   label: "Line" },
  { value: "all",    label: "All" },
];

export const CURSOR_STYLE_OPTIONS = [
  { value: "line",            label: "Line" },
  { value: "block",           label: "Block" },
  { value: "underline",       label: "Underline" },
  { value: "line-thin",       label: "Line Thin" },
  { value: "block-outline",   label: "Block Outline" },
  { value: "underline-thin",  label: "Underline Thin" },
];

export const CURSOR_BLINKING_OPTIONS = [
  { value: "blink",  label: "Blink" },
  { value: "smooth", label: "Smooth" },
  { value: "phase",  label: "Phase" },
  { value: "expand", label: "Expand" },
  { value: "solid",  label: "Solid" },
];

export const TERMINAL_CURSOR_STYLE_OPTIONS = [
  { value: "block",     label: "Block" },
  { value: "underline", label: "Underline" },
  { value: "bar",       label: "Bar" },
];

export const TAB_SIZE_OPTIONS = [
  { value: "2", label: "2" },
  { value: "4", label: "4" },
  { value: "8", label: "8" },
];

export const AI_PROVIDER_OPTIONS: { value: string; label: string }[] = [
  { value: "cloud", label: "Ollama Cloud" },
  { value: "local", label: "Local Ollama" },
];

export const AI_TRIGGER_MODE_OPTIONS: { value: string; label: string }[] = [
  { value: "auto",   label: "Auto (on pause)" },
  { value: "manual", label: "Manual (Alt+\\)" },
];

export interface ShortcutEntry {
  section: string;
  key:     string;
  label:   string;
}

export const ALL_SHORTCUTS: ShortcutEntry[] = [
  { section: "File",   key: "Ctrl+N",       label: "New note" },
  { section: "File",   key: "Ctrl+W",       label: "Close tab" },
  { section: "File",   key: "Ctrl+S",       label: "Save file" },
  { section: "File",   key: "Ctrl+⇧+S",    label: "Save As…" },
  { section: "File",   key: "Ctrl+O",       label: "Open file" },
  { section: "File",   key: "Ctrl+P",       label: "Export PDF" },
  { section: "Tabs",   key: "Ctrl+Tab",     label: "Next tab" },
  { section: "Tabs",   key: "Ctrl+⇧+Tab",  label: "Previous tab" },
  { section: "Tabs",   key: "Ctrl+1..9",    label: "Jump to tab N" },
  { section: "Editor", key: "Ctrl+/",       label: "Toggle comment" },
  { section: "Editor", key: "Ctrl+D",       label: "Duplicate line down" },
  { section: "Editor", key: "⇧+Alt+↑",     label: "Copy line up" },
  { section: "Editor", key: "⇧+Alt+↓",     label: "Copy line down" },
  { section: "Editor", key: "Alt+↑",        label: "Move line up" },
  { section: "Editor", key: "Alt+↓",        label: "Move line down" },
  { section: "Editor", key: "Ctrl+⇧+K",    label: "Delete line" },
  { section: "Editor", key: "Ctrl+L",       label: "Select line" },
  { section: "Editor", key: "Ctrl+⇧+L",    label: "Select all occurrences" },
  { section: "Editor", key: "Ctrl+]",       label: "Indent" },
  { section: "Editor", key: "Ctrl+[",       label: "Outdent" },
  { section: "Editor", key: "Ctrl+F",       label: "Find" },
  { section: "Editor", key: "Ctrl+H",       label: "Replace" },
  { section: "Editor", key: "Ctrl+G",       label: "Go to line" },
  { section: "Editor", key: "Ctrl+Scroll",  label: "Zoom font size" },
  { section: "Format", key: "Ctrl+Alt+1",   label: "Heading 1" },
  { section: "Format", key: "Ctrl+Alt+2",   label: "Heading 2" },
  { section: "Format", key: "Ctrl+Alt+3",   label: "Heading 3" },
  { section: "Format", key: "Ctrl+B",       label: "Bold" },
  { section: "Format", key: "Ctrl+I",       label: "Italic" },
  { section: "Format", key: "Ctrl+Shift+X", label: "Strikethrough" },
  { section: "Format", key: "Ctrl+E",       label: "Inline code" },
  { section: "Format", key: "Ctrl+K",       label: "Link" },
  { section: "Format", key: "Ctrl+Shift+8", label: "Bullet list" },
  { section: "Format", key: "Ctrl+Shift+7", label: "Ordered list" },
  { section: "Format", key: "Ctrl+Shift+9", label: "Task list" },
  { section: "Format", key: "Ctrl+Shift+.", label: "Blockquote" },
  { section: "Format", key: "Ctrl+Alt+C",   label: "Code block" },
  { section: "Format", key: "Ctrl+Shift+T", label: "Table" },
  { section: "Format", key: "Ctrl+Z",       label: "Undo" },
  { section: "Format", key: "Ctrl+Y",       label: "Redo" },
  { section: "Terminal", key: "Ctrl+`",        label: "Toggle terminal" },
  { section: "Terminal", key: "Ctrl+⇧+`",  label: "New terminal" },
  { section: "Terminal", key: "Ctrl+J",        label: "Focus terminal" },
  { section: "Terminal", key: "Ctrl+⇧+\\", label: "Toggle layout" },
  { section: "Terminal", key: "Ctrl+⇧+W",  label: "Close active pane" },
];

/** Order of the groups in the Shortcuts UI. */
export const SHORTCUT_GROUPS = ["File", "Tabs", "Editor", "Format", "Terminal"];

/** Common heading style for sub-sections inside settings panes. */
export const SUB_HEADING_CLASS = "text-xs font-bold uppercase tracking-wider mt-2 mb-1";
