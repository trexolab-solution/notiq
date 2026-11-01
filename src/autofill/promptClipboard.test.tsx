// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const invoke = vi.fn();
const writeText = vi.fn();
const readText = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...a: unknown[]) => writeText(...a),
  readText: (...a: unknown[]) => readText(...a),
}));

const { CopyIconButton } = await import("../components/vault/CopyIconButton");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  [invoke, writeText, readText].forEach((f) => f.mockReset());
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; vi.useRealTimers(); });

const here = dirname(fileURLToPath(import.meta.url));
const capability = (name: string) =>
  JSON.parse(readFileSync(join(here, "../../src-tauri/capabilities", `${name}.json`), "utf8")) as { windows: string[]; permissions: string[] };

describe("copying in the autofill window", () => {
  it("the window may use the clipboard plugin the secureCopy fallback needs (write, and read before the wipe)", () => {
    const cap = capability("autofill-prompt");
    expect(cap.windows).toEqual(["autofill-prompt"]);
    const clip = cap.permissions.filter((p) => p.startsWith("clipboard-manager:")).sort();
    expect(clip).toEqual(["clipboard-manager:allow-read-text", "clipboard-manager:allow-write-text"]);
    // Same grant as the quick-search popup, which uses the same fallback.
    expect(capability("quick-search").permissions.filter((p) => p.startsWith("clipboard-manager:")).sort()).toEqual(clip);
  });

  it("CopyIconButton falls back to the plugin when secure_copy is unsupported, and wipes after the delay", async () => {
    vi.useFakeTimers();
    invoke.mockRejectedValue("unsupported");
    writeText.mockResolvedValue(undefined);
    await act(async () => { root.render(<CopyIconButton value="s3cret" label="Password" />); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Copy Password"]')!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(invoke).toHaveBeenCalledWith("secure_copy", { text: "s3cret", clearAfterMs: 30_000 });
    expect(writeText).toHaveBeenCalledWith("s3cret");
    readText.mockResolvedValue("s3cret");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(readText).toHaveBeenCalled();
    expect(writeText).toHaveBeenLastCalledWith("");
  });
});
