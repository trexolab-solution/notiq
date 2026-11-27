/**
 * The one place that decides what AI may read. Vault content never reaches an AI provider: no autocomplete, action,
 * toolbar or chat context for a vault item, locked or not.
 */
import { useAppStore } from "../../store";
import { isVaultPath } from "../vault";
import type { Tab } from "../../types";

export const isVaultTab = (tab: Pick<Tab, "filePath" | "vaultExt" | "vaultLocked"> | undefined): boolean =>
  !!tab && (isVaultPath(tab.filePath) || !!tab.vaultExt || !!tab.vaultLocked);

/** An editor's text model, as far as this module cares: the note editor names each model after its tab. */
interface Model { uri?: { path?: string } }

/** The tab whose text a model holds, if it is a tab's model (a sticky note's isn't). */
export function tabOfModel(model: Model | null | undefined): Tab | undefined {
  const id = model?.uri?.path?.replace(/^\//, "");
  return id ? useAppStore.getState().tabs.find((t) => t.id === id) : undefined;
}

/**
 * Whether AI must stay away from this text. Judged by the tab the text belongs to, not by the tab on screen (which
 * may have changed while a request waited); only text that belongs to no tab is judged by the active one.
 */
export function aiBlockedFor(model: Model | null | undefined): boolean {
  const s = useAppStore.getState();
  return isVaultTab(tabOfModel(model) ?? s.tabs.find((t) => t.id === s.activeTabId));
}

/**
 * Whether AI suggestions appear by themselves as the user types. When they don't (AI off, no model, "manual"
 * trigger), the editor's own suggestions are on instead.
 */
export const aiTypesAlong = (s: { aiEnabled: boolean; aiAutocompleteEnabled: boolean; aiModel: string; aiTriggerMode: string }): boolean =>
  s.aiEnabled && s.aiAutocompleteEnabled && !!s.aiModel && s.aiTriggerMode !== "manual";
