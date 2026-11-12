// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { markNewEntry, takeNewEntry } from "../lib/entryFocus";
import { useFocusNameOnCreate } from "./useFocusNameOnCreate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Form({ path }: { path?: string }) {
  useFocusNameOnCreate(path, "name");
  return <input id="name" defaultValue="New server" />;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // run animation frames on a short timer so the hook's retry loop can be awaited
  (globalThis as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
  (globalThis as { cancelAnimationFrame: unknown }).cancelAnimationFrame = (id: number) => clearTimeout(id);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); takeNewEntry("C:/v/new.nqv"); });
const wait = () => act(async () => { await new Promise((r) => setTimeout(r, 80)); });

describe("entry focus marks", () => {
  it("are used up once and ignore slash style and case", () => {
    markNewEntry(String.raw`C:\Vault\New.nqv`);
    expect(takeNewEntry("c:/vault/new.nqv")).toBe(true);
    expect(takeNewEntry("c:/vault/new.nqv")).toBe(false);
    expect(takeNewEntry(undefined)).toBe(false);
  });
});

describe("useFocusNameOnCreate", () => {
  it("focuses and selects the Name field of a just-created entry", async () => {
    markNewEntry("C:/v/new.nqv");
    await act(async () => { root.render(<Form path="C:/v/new.nqv" />); });
    await wait();
    const el = document.getElementById("name") as HTMLInputElement;
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe("New server".length);
  });

  it("leaves focus alone for an entry that was opened normally", async () => {
    await act(async () => { root.render(<Form path="C:/v/other.nqv" />); });
    await wait();
    expect(document.activeElement).not.toBe(document.getElementById("name"));
  });
});
