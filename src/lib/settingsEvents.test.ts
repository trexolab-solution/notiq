import { describe, expect, it, vi } from "vitest";
import {
  OPEN_SETTINGS_EVENT, RUN_AI_ONBOARDING_EVENT, parseOpenSettingsDetail, requestOpenSettings, requestRunAIOnboarding,
} from "./settingsEvents";

describe("parseOpenSettingsDetail", () => {
  it("accepts a bare section id", () => {
    expect(parseOpenSettingsDetail("vault")).toEqual({ section: "vault" });
  });
  it("accepts { section, settingId }", () => {
    expect(parseOpenSettingsDetail({ section: "ai", settingId: "ai.provider.model" }))
      .toEqual({ section: "ai", settingId: "ai.provider.model" });
    expect(parseOpenSettingsDetail({ section: "ai", settingId: "" })).toEqual({ section: "ai" });
  });
  it("ignores anything unrecognised (just opens Settings)", () => {
    expect(parseOpenSettingsDetail(undefined)).toEqual({});
    expect(parseOpenSettingsDetail("nope")).toEqual({});
    expect(parseOpenSettingsDetail({ section: "nope", settingId: "x" })).toEqual({});
    expect(parseOpenSettingsDetail(42)).toEqual({});
  });
});

describe("event helpers", () => {
  it("dispatch the documented window events", () => {
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    const seen: { type: string; detail?: unknown }[] = [];
    win.addEventListener(OPEN_SETTINGS_EVENT, (e) => seen.push({ type: e.type, detail: (e as CustomEvent).detail }));
    win.addEventListener(RUN_AI_ONBOARDING_EVENT, (e) => seen.push({ type: e.type }));
    requestOpenSettings("ai", "ai.x");
    requestOpenSettings();
    requestRunAIOnboarding();
    expect(seen).toEqual([
      { type: "app:open-settings", detail: { section: "ai", settingId: "ai.x" } },
      { type: "app:open-settings", detail: null },
      { type: "app:run-ai-onboarding" },
    ]);
    vi.unstubAllGlobals();
  });
});
