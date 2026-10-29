import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { HELLO_OFF, helloStatus, helloWasTurnedOff, isHelloCancel, normalizeHelloStatus } from "./hello";

describe("windows hello helpers", () => {
  it("normalizes the status reply", () => {
    expect(normalizeHelloStatus({ supported: true, enabled: true })).toEqual({ supported: true, enabled: true });
    expect(normalizeHelloStatus({ supported: true, enabled: false })).toEqual({ supported: true, enabled: false });
    // enabled never without supported
    expect(normalizeHelloStatus({ supported: false, enabled: true })).toEqual(HELLO_OFF);
    expect(normalizeHelloStatus(null)).toEqual(HELLO_OFF);
    expect(normalizeHelloStatus("yes")).toEqual(HELLO_OFF);
    expect(normalizeHelloStatus({ supported: "true", enabled: 1 })).toEqual(HELLO_OFF);
  });

  it("treats a failing status call as unsupported", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("boom");
    await expect(helloStatus()).resolves.toEqual(HELLO_OFF);
    vi.mocked(invoke).mockResolvedValueOnce({ supported: true, enabled: true });
    await expect(helloStatus()).resolves.toEqual({ supported: true, enabled: true });
  });

  it("classifies backend messages", () => {
    expect(isHelloCancel("Windows Hello was cancelled. Use your master password or try again.")).toBe(true);
    expect(isHelloCancel("Windows Hello couldn't verify you")).toBe(false);
    expect(helloWasTurnedOff("Windows Hello unlock has been turned off. Unlock with your master password.")).toBe(true);
    expect(helloWasTurnedOff("Windows Hello couldn't verify you")).toBe(false);
  });
});
