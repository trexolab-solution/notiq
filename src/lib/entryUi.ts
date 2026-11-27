/**
 * How each open vault entry is being looked at: in Edit mode or not, and which section of its form is shown.
 * Held in memory only. It survives switching between tabs (the form unmounts then) but not an app restart.
 */
import { create } from "zustand";

interface EntryUiState {
  /** Tabs whose form is unlocked for editing. */
  editing: Record<string, boolean>;
  /** Shown section, by tab id and by entry path (so reopening a closed or replaced tab lands where it was). */
  sections: Record<string, string>;
}

export const useEntryUi = create<EntryUiState>(() => ({ editing: {}, sections: {} }));

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...record };
  delete next[key];
  return next;
};

export function setEntryEditing(tabId: string, on: boolean): void {
  useEntryUi.setState((s) => ({ editing: on ? { ...s.editing, [tabId]: true } : without(s.editing, tabId) }));
}

/** A tab with unsaved changes is always in Edit mode. */
export const useEntryEditing = (tab: { id: string; isDirty?: boolean }): boolean =>
  useEntryUi((s) => !!s.editing[tab.id]) || !!tab.isDirty;

export function setEntrySection(tabId: string, path: string | undefined, section: string): void {
  useEntryUi.setState((s) => ({ sections: { ...s.sections, [tabId]: section, ...(path ? { [path]: section } : {}) } }));
}

/** Forgets a closed tab's Edit mode (its entry's section is still remembered by path). */
export function forgetEntryTab(tabId: string): void {
  useEntryUi.setState((s) => ({ editing: without(s.editing, tabId), sections: without(s.sections, tabId) }));
}

/** Vault locked: every form goes back to view mode. */
export function endAllEntryEditing(): void {
  useEntryUi.setState({ editing: {} });
}
