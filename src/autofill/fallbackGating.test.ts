import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { isFallbackRequest } from "../lib/autofill";
import { vaultSyncAction } from "../store/vaultStore";

describe("main-window fallback gating", () => {
  it("only requests Rust marked as fallback reach the main-window dialogs", () => {
    expect(isFallbackRequest({ id: "a", host: "example.com", fallback: true })).toBe(true);
    // Everything the prompt window handles is ignored by the main window.
    expect(isFallbackRequest({ id: "a", host: "example.com" })).toBe(false);
    expect(isFallbackRequest({ id: "a", host: "example.com", fallback: false })).toBe(false);
    expect(isFallbackRequest({ id: "a", host: "example.com", fallback: "true" })).toBe(false);
    expect(isFallbackRequest({ id: "a", host: "example.com", fallback: 1 })).toBe(false);
    expect(isFallbackRequest(null)).toBe(false);
    expect(isFallbackRequest("fallback")).toBe(false);
  });
});

describe("cross-window vault state", () => {
  it("follows an unlock done in the prompt window", () => {
    expect(vaultSyncAction({ unlocked: true, source: "autofill-prompt" }, { unlocked: false }, "main")).toBe("unlocked");
    expect(vaultSyncAction({ unlocked: false, source: "autofill-prompt" }, { unlocked: true }, "main")).toBe("locked");
  });
  it("ignores its own commands and no-op events (no echo, no double work)", () => {
    expect(vaultSyncAction({ unlocked: true, source: "main" }, { unlocked: false }, "main")).toBe("ignore");
    expect(vaultSyncAction({ unlocked: true, source: "autofill-prompt" }, { unlocked: true }, "main")).toBe("ignore");
    expect(vaultSyncAction({ unlocked: false, source: "autofill-prompt" }, { unlocked: false }, "main")).toBe("ignore");
    expect(vaultSyncAction({} as never, { unlocked: false }, "main")).toBe("ignore");
  });
});
