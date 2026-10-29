import type { Tab } from "../types";
import type { SectionId } from "./settingsIndex";

type KindOnly = Pick<Tab, "kind"> | null | undefined;

/** The singleton Settings tab (no file, no content). */
export const isSettingsTab = (t: KindOnly): boolean => t?.kind === "settings";

/**
 * A tab that holds user content (a note or a whiteboard): it can be saved, linked, searched, counted,
 * graphed and sent to AI as context. The Settings tab is not a content tab.
 */
export const isContentTab = (t: KindOnly): boolean => !!t && t.kind !== "settings";

/** A text note (not a whiteboard, not Settings). */
export const isNoteTab = (t: KindOnly): boolean => t?.kind === "note";

export const SETTINGS_TAB_TITLE = "Settings";

/** Where the Settings page should scroll to. `nonce` changes on every request so repeats re-trigger. */
export interface SettingsTarget {
  section: SectionId;
  settingId?: string;
  nonce: number;
}

/**
 * Session restore: keep at most one Settings tab (the first), normalised to its invariants
 * (fixed title, no content, never dirty, no file). Every other tab is returned untouched.
 */
export function normalizeSettingsTabs<T extends Tab>(tabs: T[]): T[] {
  let seen = false;
  const out: T[] = [];
  for (const t of tabs) {
    if (t.kind !== "settings") { out.push(t); continue; }
    if (seen) continue;
    seen = true;
    out.push({ ...t, title: SETTINGS_TAB_TITLE, content: "", isDirty: false, filePath: undefined });
  }
  return out;
}
