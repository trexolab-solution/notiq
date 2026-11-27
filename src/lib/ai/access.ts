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

/** Models that belong to no tab but that AI may read (the sticky note editor's). */
const allowed = new WeakSet<object>();
export function allowAiFor(model: object | null | undefined): void {
  if (model) allowed.add(model);
}

/**
 * Whether AI must stay away from this text. A tab's text is judged by that tab, not by the one on screen (which may
 * have changed while a request waited). Any other editor is off limits unless it was allowed by name: a server's
 * file in the file manager (an `.env`, a key) must never be sent to an AI provider.
 */
export function aiBlockedFor(model: Model | null | undefined): boolean {
  if (!model) return true;
  const tab = tabOfModel(model);
  return tab ? isVaultTab(tab) : !allowed.has(model);
}

/**
 * Whether AI suggestions appear by themselves as the user types. When they don't (AI off, no model, "manual"
 * trigger), the editor's own suggestions are on instead.
 */
export const aiTypesAlong = (s: { aiEnabled: boolean; aiAutocompleteEnabled: boolean; aiModel: string; aiTriggerMode: string }): boolean =>
  s.aiEnabled && s.aiAutocompleteEnabled && !!s.aiModel && s.aiTriggerMode !== "manual";
