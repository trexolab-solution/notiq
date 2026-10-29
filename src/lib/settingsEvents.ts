import { SECTION_ORDER, type SectionId } from "./settingsIndex";

/**
 * Window events around the Settings tab, for code that can't (or shouldn't) reach the store directly.
 *  - `app:open-settings`       detail: a SectionId, or `{ section, settingId }`, or nothing → `openSettings(...)`.
 *  - `app:run-ai-onboarding`   no detail → shows the AI onboarding wizard (the AI section's "Run setup again").
 */
export const OPEN_SETTINGS_EVENT = "app:open-settings";
export const RUN_AI_ONBOARDING_EVENT = "app:run-ai-onboarding";

export interface OpenSettingsRequest { section?: SectionId; settingId?: string }

const isSection = (v: unknown): v is SectionId => typeof v === "string" && (SECTION_ORDER as string[]).includes(v);

/** Validates an `app:open-settings` detail; anything unrecognised just opens Settings. */
export function parseOpenSettingsDetail(detail: unknown): OpenSettingsRequest {
  if (isSection(detail)) return { section: detail };
  if (detail && typeof detail === "object") {
    const { section, settingId } = detail as { section?: unknown; settingId?: unknown };
    if (isSection(section)) {
      return typeof settingId === "string" && settingId ? { section, settingId } : { section };
    }
  }
  return {};
}

export function requestOpenSettings(section?: SectionId, settingId?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: section ? { section, settingId } : undefined }));
}

export function requestRunAIOnboarding(): void {
  window.dispatchEvent(new Event(RUN_AI_ONBOARDING_EVENT));
}
