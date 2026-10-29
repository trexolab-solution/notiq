/**
 * Search index data for the General / Editor / Terminal / Appearance / Shortcuts / Updates / About sections.
 * Pure data (no store, no Tauri, no DOM) so it can be unit-tested; each section re-exports its list as
 * `SETTINGS_INDEX`. Every entry here must match a rendered `SettingRow` / `SettingsBlock` (same id + label) —
 * settingsIndex.test.ts enforces that.
 */
import type { SectionId, SettingMeta } from "../../../lib/settingsIndex";
import { ALL_SHORTCUTS, SHORTCUT_GROUPS, type ShortcutEntry } from "./settingsConstants";

const make = (section: SectionId) =>
  (id: string, group: string, label: string, description?: string, keywords?: string[]): SettingMeta =>
    ({ id, section, group, label, description, keywords });

// ── General ──────────────────────────────────────────────────────────────────
const g = make("general");
export const GENERAL_INDEX: SettingMeta[] = [
  g("general.startup.launch", "Startup", "Launch at sign-in",
    "Start Notiq automatically when you sign in to your computer. It opens minimized in the system tray.",
    ["autostart", "auto start", "startup", "boot", "login", "tray", "background", "minimized"]),
  g("general.help.tour", "Help", "Welcome tour",
    "Walk through the main features again: tabs, the sidebar, the terminal, the vault and AI.",
    ["tour", "onboarding", "tutorial", "walkthrough", "guide", "introduction"]),
  g("general.help.whats-new", "Help", "What's new",
    "Open the release notes for the version you are running.",
    ["changelog", "release notes", "news", "version", "update"]),
];

// ── Editor ───────────────────────────────────────────────────────────────────
const e = make("editor");
export const EDITOR_INDEX: SettingMeta[] = [
  e("editor.font.size", "Font", "Font size",
    "Text size in the editor, in pixels. Ctrl + mouse wheel also changes it.",
    ["font size", "text size", "zoom", "bigger", "smaller", "px"]),
  e("editor.font.family", "Font", "Font family",
    "Monospace font used for note source and code.",
    ["typeface", "monospace", "jetbrains", "fira", "cascadia", "consolas"]),
  e("editor.font.letter-spacing", "Font", "Letter spacing",
    "Extra space between characters, in pixels.",
    ["tracking", "kerning", "character spacing"]),

  e("editor.display.line-numbers", "Display", "Line numbers",
    "Show line numbers in the gutter.",
    ["gutter", "line number"]),
  e("editor.display.word-wrap", "Display", "Word wrap",
    "Wrap long lines at the edge of the editor instead of scrolling sideways.",
    ["wrap", "soft wrap", "line wrap", "horizontal scroll"]),
  e("editor.display.minimap", "Display", "Minimap",
    "Show a small overview of the whole note along the right edge.",
    ["overview", "map", "scrollbar preview"]),
  e("editor.display.whitespace", "Display", "Show whitespace",
    "Draw dots and arrows for spaces and tabs.",
    ["render whitespace", "spaces", "tabs", "invisible characters", "trailing"]),
  e("editor.display.line-highlight", "Display", "Current line highlight",
    "How the line with the cursor is highlighted.",
    ["active line", "highlight", "render line highlight"]),
  e("editor.display.bracket-colors", "Display", "Bracket pair colors",
    "Give each level of matching brackets its own color.",
    ["bracket", "colorize", "rainbow", "parentheses"]),
  e("editor.display.folding", "Display", "Code folding",
    "Show arrows in the gutter to collapse headings, lists and code blocks.",
    ["fold", "collapse", "expand", "regions"]),

  e("editor.cursor.style", "Cursor", "Cursor style",
    "Shape of the text cursor.",
    ["caret", "cursor shape", "block", "underline", "line"]),
  e("editor.cursor.blinking", "Cursor", "Cursor animation",
    "How the text cursor blinks.",
    ["caret", "blink", "blinking", "smooth"]),

  e("editor.editing.default-mode", "Editing", "Default view for new notes",
    "Which view a newly created note opens in.",
    ["mode", "markdown", "preview", "split", "source", "new note"]),
  e("editor.editing.tab-size", "Editing", "Tab size",
    "Number of spaces a tab inserts and displays as.",
    ["indent", "indentation", "spaces", "tab width"]),
  e("editor.editing.auto-close", "Editing", "Auto-close brackets",
    "Type the closing bracket or quote for you.",
    ["brackets", "quotes", "autoclose", "pair"]),
  e("editor.editing.format-on-paste", "Editing", "Format on paste",
    "Re-indent pasted code to match the surrounding text.",
    ["paste", "format", "indent"]),

  e("editor.scrolling.smooth", "Scrolling", "Smooth scrolling",
    "Animate scrolling instead of jumping.",
    ["animation", "scroll"]),
  e("editor.scrolling.speed", "Scrolling", "Scroll speed",
    "How far one notch of the mouse wheel scrolls.",
    ["mouse wheel", "sensitivity", "scroll"]),
  e("editor.scrolling.past-end", "Scrolling", "Scroll past last line",
    "Let the last line scroll up to the top of the editor.",
    ["scroll beyond", "end of file", "overscroll"]),
];

// ── Terminal ─────────────────────────────────────────────────────────────────
const t = make("terminal");
export const TERMINAL_INDEX: SettingMeta[] = [
  t("terminal.font.size", "Font", "Font size",
    "Text size in the terminal, in pixels.",
    ["font size", "text size", "zoom", "shell", "console", "px"]),
  t("terminal.cursor.style", "Cursor", "Cursor style",
    "Shape of the terminal cursor.",
    ["caret", "block", "underline", "bar", "shell", "console"]),
  t("terminal.cursor.blink", "Cursor", "Blinking cursor",
    "Make the terminal cursor blink.",
    ["caret", "blink", "shell", "console"]),
  t("terminal.behaviour.scrollback", "Behaviour", "Scrollback",
    "How many lines of output each terminal keeps for scrolling back.",
    ["history", "buffer", "lines", "shell", "console"]),
  t("terminal.behaviour.position", "Behaviour", "Panel position",
    "Where the terminal panel opens. Ctrl+Shift+\\ switches it.",
    ["layout", "dock", "bottom", "right", "split", "horizontal", "vertical", "shell", "console"]),
];

// ── Appearance ───────────────────────────────────────────────────────────────
const a = make("appearance");
export const APPEARANCE_INDEX: SettingMeta[] = [
  a("appearance.theme.color-theme", "Theme", "Color theme",
    "Colors for the whole app: editor, sidebar, terminal and dialogs.",
    ["theme", "dark", "light", "dark mode", "light mode", "colors", "palette", "nord", "dracula", "solarized", "monokai", "catppuccin", "gruvbox"]),
];

// ── Shortcuts ────────────────────────────────────────────────────────────────
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Stable id of a shortcut row: "shortcuts.<group>.<label>". Used by both the index and ShortcutsSection. */
export const shortcutId = (s: ShortcutEntry) => `shortcuts.${slug(s.section)}.${slug(s.label)}`;

/** Description shown under a shortcut's label (only the configurable one has one). */
export const shortcutDescription = (s: ShortcutEntry) =>
  s.label === "Lock vault now" ? "Change this shortcut in Vault settings." : undefined;

/** Search words for a shortcut: its keys spelled out, so "ctrl b" or "shift" find it. */
export const shortcutKeywords = (s: ShortcutEntry) =>
  ["shortcut", "keybinding", "hotkey", "key", s.key, s.key.replace(/\+/g, " ").replace(/⇧/g, "shift")];

export const SHORTCUTS_INDEX: SettingMeta[] = SHORTCUT_GROUPS.flatMap((grp) =>
  ALL_SHORTCUTS.filter((s) => s.section === grp).map((s): SettingMeta => ({
    id: shortcutId(s), section: "shortcuts", group: grp, label: s.label,
    description: shortcutDescription(s), keywords: shortcutKeywords(s),
  })),
);

// ── Updates ──────────────────────────────────────────────────────────────────
const u = make("updates");
export const UPDATES_INDEX: SettingMeta[] = [
  u("updates.status.current", "Status", "Current version",
    "The version you are running and whether a newer one is available.",
    ["update", "upgrade", "check for updates", "version", "download", "install", "restart"]),
  u("updates.auto.check", "Automatic updates", "Check for updates automatically",
    "Check when Notiq starts and then every hour while it runs.",
    ["auto update", "automatic", "hourly", "background", "github", "release"]),
];

// ── About ────────────────────────────────────────────────────────────────────
const b = make("about");
export const ABOUT_INDEX: SettingMeta[] = [
  b("about.app.info", "Notiq", "About Notiq",
    "Version, credits and copyright.",
    ["version", "about", "trexolab", "copyright", "license", "credits"]),
  b("about.links.website", "Links", "Website",
    "trexolab.com: news, docs and other TrexoLab apps.",
    ["homepage", "site", "trexolab", "link"]),
  b("about.links.source", "Links", "Source code",
    "The Notiq repository on GitHub: report issues, read the code.",
    ["github", "repository", "repo", "issues", "bug", "open source", "link"]),
];

// ── Row props from the index ─────────────────────────────────────────────────
/**
 * `const m = indexProps(EDITOR_INDEX)` then `<SettingRow {...m("editor.font.size")}>`: the row's id, label,
 * description and search keywords come straight from the index, so the UI and search can't drift apart.
 */
export function indexProps(index: SettingMeta[]) {
  const byId = new Map(index.map((s) => [s.id, s]));
  return (id: string) => {
    const s = byId.get(id);
    if (!s) throw new Error(`Unknown setting id "${id}"`);
    return { id: s.id, label: s.label, description: s.description, keywords: s.keywords };
  };
}
