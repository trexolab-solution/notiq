/** Shared vocabulary of the Settings tab: sections, and the searchable index every section exports. */

export type SectionId =
  | "general" | "editor" | "ai" | "vault" | "terminal" | "appearance" | "shortcuts" | "updates" | "about";

/** Order of the sections in the nav and in the scrolling page. */
export const SECTION_ORDER: SectionId[] = [
  "general", "editor", "ai", "vault", "terminal", "appearance", "shortcuts", "updates", "about",
];

export const SECTION_LABELS: Record<SectionId, string> = {
  general: "General", editor: "Editor", ai: "AI", vault: "Vault", terminal: "Terminal",
  appearance: "Appearance", shortcuts: "Shortcuts", updates: "Updates", about: "About",
};

/**
 * One searchable setting. Every section module exports `SETTINGS_INDEX: SettingMeta[]` listing every
 * `SettingRow` / `SettingsBlock` it renders. `id` is globally unique ("<section>.<group>.<name>") and is the
 * value passed as the row's `id` prop; the DOM id is `settingDomId(id)`, used for deep links and "reveal".
 */
export interface SettingMeta {
  id: string;
  section: SectionId;
  /** Sub-group inside the section (shown as a breadcrumb), e.g. "Backup". */
  group?: string;
  label: string;
  description?: string;
  /** Extra words people might search for ("dark", "font", "password"…). */
  keywords?: string[];
}

export const settingDomId = (id: string) => `setting-${id}`;
