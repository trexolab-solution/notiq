import { SlidersHorizontal } from "lucide-react";
import type { Command } from "../components/ui/CommandPalette";
import { SECTION_LABELS, type SectionId, type SettingMeta } from "./settingsIndex";
import { rankSettings } from "./settingsSearch";

export type OpenSettingsFn = (section?: SectionId, settingId?: string) => void;

/** Max settings listed in the command palette for one query (keeps the list and the render cheap). */
export const PALETTE_SETTINGS_LIMIT = 12;

/**
 * Command-palette entries for the settings matching `query`: "Settings › <Section> › <Label>", each one
 * opening the Settings tab at that setting. Empty query → no entries (the palette shows its normal list).
 */
export function settingsCommandsFor(
  query: string, items: SettingMeta[], openSettings: OpenSettingsFn, limit = PALETTE_SETTINGS_LIMIT,
): Command[] {
  return rankSettings(items, query, limit).map((m) => ({
    id: `setting:${m.id}`,
    label: `Settings › ${SECTION_LABELS[m.section]} › ${m.label}`,
    group: "Matching settings",
    hint: m.group, // sub-group breadcrumb, shown dimmed after the label
    icon: <SlidersHorizontal size={14} />,
    run: () => openSettings(m.section, m.id),
  }));
}
