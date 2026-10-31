import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};

const invoke = vi.fn();
const writeText = vi.fn();
const readText = vi.fn();
const info = vi.fn();
const error = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...a: unknown[]) => writeText(...a),
  readText: (...a: unknown[]) => readText(...a),
}));
vi.mock("./toast", () => ({ toast: { info: (...a: unknown[]) => info(...a), error: (...a: unknown[]) => error(...a) } }));

const { copySecret, copySecretTimed, copiedMessage } = await import("./secureCopy");
const {
  clipboardClearLabel, CLIPBOARD_CLEAR_OPTIONS, DEFAULT_CLIPBOARD_CLEAR_SECONDS, getClipboardClearSeconds,
  parseClipboardClearSeconds, setClipboardClearSeconds,
} = await import("./vaultPrefs");

beforeEach(() => {
  mem.clear();
  [invoke, writeText, readText, info, error].forEach((f) => f.mockReset());
  vi.useRealTimers();
});

describe("clipboard clear setting", () => {
  it("defaults to 30 s and offers 15 s / 30 s / 1 min / 2 min / Never", () => {
    expect(DEFAULT_CLIPBOARD_CLEAR_SECONDS).toBe(30);
    expect(CLIPBOARD_CLEAR_OPTIONS.map(clipboardClearLabel)).toEqual(["15 s", "30 s", "1 min", "2 min", "Never"]);
    expect(getClipboardClearSeconds()).toBe(30);
  });
  it("accepts only the offered values", () => {
    expect(parseClipboardClearSeconds(null)).toBe(30);
    expect(parseClipboardClearSeconds("0")).toBe(0);
    expect(parseClipboardClearSeconds("120")).toBe(120);
    expect(parseClipboardClearSeconds("45")).toBe(30);
    expect(parseClipboardClearSeconds("abc")).toBe(30);
    setClipboardClearSeconds(60);
    expect(mem.get("pref:vaultClipboardClearSeconds")).toBe("60");
    expect(getClipboardClearSeconds()).toBe(60);
  });
});

describe("copySecret", () => {
  it("asks the native copy to clear after the setting", async () => {
    setClipboardClearSeconds(15);
    invoke.mockResolvedValue(undefined);
    expect(await copySecretTimed("pw", "Password")).toBe(15);
    expect(invoke).toHaveBeenCalledWith("secure_copy", { text: "pw", clearAfterMs: 15_000 });
    expect(info).toHaveBeenCalledWith("Password copied — clears in 15 s");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("Never: no wipe is scheduled and the toast says nothing about clearing", async () => {
    setClipboardClearSeconds(0);
    invoke.mockResolvedValue(undefined);
    expect(await copySecret("pw", "Password")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("secure_copy", { text: "pw", clearAfterMs: 0 });
    expect(info).toHaveBeenCalledWith("Password copied");
  });

  it("fallback path wipes only if the clipboard still holds the secret", async () => {
    vi.useFakeTimers();
    setClipboardClearSeconds(60);
    invoke.mockRejectedValue("unsupported");
    writeText.mockResolvedValue(undefined);
    expect(await copySecret("pw", "Password", { quiet: true })).toBe(true);
    expect(info).not.toHaveBeenCalled();
    readText.mockResolvedValue("something else");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writeText).toHaveBeenCalledTimes(1); // not cleared: the user copied something else

    await copySecret("pw2", "Password", { quiet: true });
    readText.mockResolvedValue("pw2");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(writeText).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writeText).toHaveBeenLastCalledWith("");
  });

  it("reports a failed copy", async () => {
    invoke.mockRejectedValue("busy");
    writeText.mockRejectedValue("no");
    expect(await copySecretTimed("pw", "Password", { quiet: true })).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it("copiedMessage", () => {
    expect(copiedMessage("Code", 120)).toBe("Code copied — clears in 2 min");
    expect(copiedMessage("Code", 0)).toBe("Code copied");
  });
});
