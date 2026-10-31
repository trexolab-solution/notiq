// Decide which right-click menu (if any) a click target gets.
//
// The window-level handler (useGlobalContextMenu, useWindowContextMenu) asks this
// instead of falling back to one catch-all menu: every surface gets the menu that
// matches what was clicked, and anything else gets none (the browser's own menu is
// always suppressed so it never leaks into the packaged app).

/** Anything with `Element.closest` — keeps this module DOM-free for unit tests. */
export interface ClosestLike {
  closest(selector: string): unknown;
}

export type ContextArea =
  /** Monaco editor: edit + find + AI actions. */
  | "editor"
  /** A plain text input / textarea: Cut / Copy / Paste / Select all. */
  | "text-field"
  /** Rendered Markdown preview: Copy / Select all / Copy link. */
  | "preview"
  /** Empty space in the tab strip (a tab row opens its own menu). */
  | "tab-strip"
  /** The locked Secure Vault panel: Unlock. */
  | "vault-locked"
  /** Surfaces that open their own menu (whiteboard, terminal, vault tree). */
  | "self-managed"
  /** Chrome with nothing to act on: status bar, titlebar, settings, dialogs… */
  | "none";

/** Text-entry fields only — checkboxes, ranges, buttons etc. get no text menu. */
export const TEXT_FIELD_SELECTOR = [
  "textarea",
  "input:not([type])",
  ...["text", "search", "url", "email", "tel", "password", "number"].map((t) => `input[type='${t}']`),
].join(", ");

export const AREA_SELECTORS = {
  editor:      ".monaco-editor",
  textField:   TEXT_FIELD_SELECTOR,
  selfManaged: ".excalidraw, .terminal-xterm-wrap, .vt-scroll",
  preview:     ".prose-scroll",
  tabStrip:    ".tab-strip",
  vaultLocked: "[data-context-area='vault-locked']",
} as const;

/** Most specific first: Monaco's hidden textarea is an editor, not a text field. */
export function classifyContextTarget(t: ClosestLike | null): ContextArea {
  if (!t) return "none";
  if (t.closest(AREA_SELECTORS.editor))      return "editor";
  if (t.closest(AREA_SELECTORS.textField))   return "text-field";
  if (t.closest(AREA_SELECTORS.selfManaged)) return "self-managed";
  if (t.closest(AREA_SELECTORS.preview))     return "preview";
  if (t.closest(AREA_SELECTORS.tabStrip))    return "tab-strip";
  if (t.closest(AREA_SELECTORS.vaultLocked)) return "vault-locked";
  return "none";
}

/**
 * True when the click lands in a text field. Areas with their own menu (a tab row,
 * the vault tree) skip opening it then, so an inline rename box gets the text menu.
 */
export function isTextFieldTarget(t: EventTarget | null): boolean {
  return typeof Element !== "undefined" && t instanceof Element && !!t.closest(TEXT_FIELD_SELECTOR);
}
