import { PREFERENCE_DEFAULTS } from "../../../store/preferences";

/**
 * `modified` + `onReset` props for a SettingRow bound to a store preference that has a default in
 * PREFERENCE_DEFAULTS: `<SettingRow {...prefReset("wordWrap", wordWrap, setWordWrap)}>`.
 */
export function prefReset<T>(key: string, value: T, set: (v: T) => void) {
  if (!(key in PREFERENCE_DEFAULTS)) throw new Error(`No default for preference "${key}"`);
  const def = PREFERENCE_DEFAULTS[key] as T;
  return { modified: value !== def, onReset: () => set(def) };
}
