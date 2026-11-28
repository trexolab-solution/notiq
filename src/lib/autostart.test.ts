// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const enable = vi.fn(async () => {});
const disable = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-autostart", () => ({ enable: () => enable(), disable: () => disable(), isEnabled: async () => false }));

const { ensureAutostart, setAutostart } = await import("./autostart");
const { APP_VERSION } = await import("../config/app");

beforeEach(() => { localStorage.clear(); enable.mockReset(); enable.mockResolvedValue(undefined); disable.mockClear(); });

describe("launch at sign-in", () => {
  it("is made sure of once per version, also for an install that had already run", async () => {
    localStorage.setItem("autostart:firstRunDone", "1"); // set by earlier versions
    await ensureAutostart(false);
    await ensureAutostart(false);
    expect(enable).toHaveBeenCalledTimes(1);
    localStorage.setItem("autostart:ensuredVersion", "0.0.1"); // as after an update
    await ensureAutostart(false);
    expect(enable).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("autostart:ensuredVersion")).toBe(APP_VERSION);
  });

  it("stays off after the user turned it off, until they turn it on again", async () => {
    await setAutostart(false, false);
    await ensureAutostart(false);
    expect(disable).toHaveBeenCalledTimes(1);
    expect(enable).not.toHaveBeenCalled();
    await setAutostart(true, false);
    localStorage.removeItem("autostart:ensuredVersion");
    await ensureAutostart(false);
    expect(enable).toHaveBeenCalledTimes(2);
  });

  it("tries again next time when it fails", async () => {
    enable.mockRejectedValueOnce(new Error("denied"));
    await ensureAutostart(false);
    await ensureAutostart(false);
    expect(enable).toHaveBeenCalledTimes(2);
  });

  it("a development build never touches the startup entry", async () => {
    await ensureAutostart(true);
    await expect(setAutostart(true, true)).rejects.toThrow();
    await expect(setAutostart(false, true)).rejects.toThrow();
    expect(enable).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
  });
});
