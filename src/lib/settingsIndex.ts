/** Shared vocabulary of the Settings tab: sections, and the searchable index every section exports. */

export type SectionId =
  | "general" | "editor" | "appearance" | "shortcuts" | "ai" | "terminal" | "files" | "share" | "vault" | "updates" | "about";

/** The nav's headings and the sections under each (also the order of the scrolling page). */
export const SECTION_GROUPS: { label: string; ids: SectionId[] }[] = [
  { label: "Workspace", ids: ["general", "editor", "appearance", "shortcuts"] },
  { label: "Tools", ids: ["ai", "terminal", "files", "share"] },
  { label: "Security", ids: ["vault"] },
  { label: "App", ids: ["updates", "about"] },
];

/** Order of the sections in the nav and in the scrolling page. */
export const SECTION_ORDER: SectionId[] = SECTION_GROUPS.flatMap((g) => g.ids);

export const SECTION_LABELS: Record<SectionId, string> = {
  general: "General", editor: "Editor", appearance: "Appearance", shortcuts: "Shortcuts",
  ai: "AI", terminal: "Terminal", files: "File Manager", share: "Phone Share",
  vault: "Vault", updates: "Updates", about: "About",
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
