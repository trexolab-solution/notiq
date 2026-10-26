/** Keyboard-combo helpers for user-customizable shortcuts ("Ctrl+Alt+L"). */

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph"]);

/** Canonical combo string for a keydown, or null if only modifiers are held. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (e.key === " ") key = "Space";
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(key);
  return parts.join("+");
}

/** A usable shortcut needs Ctrl/Alt/Meta (or be a function key). */
export function hasRequiredModifier(combo: string): boolean {
  return /^(.*\+)?(Ctrl|Alt|Meta)\+/.test(combo) || /(^|\+)F([1-9]|1[0-2])$/.test(combo);
}

export const normalizeCombo = (s: string) =>
  s.replace(/⇧/g, "Shift").replace(/\s+/g, "").toLowerCase();
