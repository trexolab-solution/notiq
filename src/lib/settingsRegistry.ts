import type { SettingMeta } from "./settingsIndex";
import { SETTINGS_INDEX as general }    from "../components/ui/settings/GeneralSection";
import { SETTINGS_INDEX as editor }     from "../components/ui/settings/EditorSettingsSection";
import { SETTINGS_INDEX as ai }         from "../components/ui/settings/AISettingsSection";
import { SETTINGS_INDEX as vault }      from "../components/ui/settings/VaultSection";
import { SETTINGS_INDEX as terminal }   from "../components/ui/settings/TerminalSettingsSection";
import { SETTINGS_INDEX as appearance } from "../components/ui/settings/AppearanceSection";
import { SETTINGS_INDEX as shortcuts }  from "../components/ui/settings/ShortcutsSection";
import { SETTINGS_INDEX as updates }    from "../components/ui/settings/UpdatesSection";
import { SETTINGS_INDEX as about }      from "../components/ui/settings/AboutSection";

/** Every searchable setting of every section, in section order. */
export const ALL_SETTINGS: SettingMeta[] = [
  ...general, ...editor, ...ai, ...vault, ...terminal, ...appearance, ...shortcuts, ...updates, ...about,
];
