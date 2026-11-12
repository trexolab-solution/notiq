// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ED25519_PRIV, ED25519_PUB, RSA_PUB } from "../../lib/__fixtures__/sshKeys";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const dialogOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => dialogOpen(...a), save: vi.fn(), ask: vi.fn() }));
/** Fake disk: path → text (a missing path fails like a folder / unreadable file). */
let disk: Record<string, string> = {};
vi.mock("@tauri-apps/plugin-fs", () => ({
  stat: async (p: string) => {
    if (p.endsWith("/folder")) return { isDirectory: true, size: 0 };
    if (!(p in disk)) throw new Error("not found");
    return { isDirectory: false, size: disk[p].length };
  },
  readTextFile: async (p: string) => disk[p],
  readFile: async () => new Uint8Array(), exists: async () => true, mkdir: async () => {},
}));
vi.mock("../../lib/vault", async (orig) => ({
  ...(await orig<typeof import("../../lib/vault")>()),
  vaultAttachList: async () => [],
}));
vi.mock("../../lib/attachmentLimits", async (orig) => ({
  ...(await orig<typeof import("../../lib/attachmentLimits")>()),
  vaultAttachmentsUsed: async () => 0,
}));
vi.mock("../../lib/vaultDir", () => ({ resolveVaultDir: async () => "C:/vault" }));
const copySecret = vi.fn(async () => true);
vi.mock("../../lib/secureCopy", () => ({ copySecret: (...a: unknown[]) => copySecret(...(a as [])) }));
const toastInfo = vi.fn();
vi.mock("../../lib/toast", () => ({
  toast: { info: (...a: unknown[]) => toastInfo(...a), error: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SshEntryEditor } = await import("./SshEntryEditor");
const { useAppStore } = await import("../../store");
const { useVaultStore } = await import("../../store/vaultStore");
const { clearDropTargets, dropAt } = await import("../../lib/dropTargets");
const { VAULT_HIDE_SECRETS_EVENT } = await import("../../hooks/useAutoHide");
type Tab = import("../../types").Tab;

const PATH = "C:/vault/SSH/Prod.nqv";
/** An entry saved by an older version: no public key, key files or custom fields. */
const OLD = JSON.stringify({ v: 1, kind: "ssh", title: "Prod", fields: { host: "srv.example.com", username: "root", privateKey: ED25519_PRIV, passphrase: "", auth: "key" } });
const makeTab = (content: string) => ({ id: "t1", title: "Prod.nqv", filePath: PATH, content, isDirty: false, vaultExt: "ssh" } as unknown as Tab);

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(50); });
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const btn = (label: string) => q<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text))!;
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const live = () => q('[data-ssh-live] [role="status"]')!.textContent ?? "";
const stored = () => JSON.parse(useAppStore.getState().tabs[0].content) as { title: string; fields: Record<string, string>; custom: unknown[] };
const priv = () => q<HTMLTextAreaElement>("#ssh-key")!;
const pub = () => q<HTMLTextAreaElement>("#ssh-pub")!;

/** Re-renders with the tab as the store holds it, like EditorContainer does. */
function Host() {
  const tab = useAppStore((s) => s.tabs[0]);
  return <SshEntryEditor tab={tab} />;
}

async function render(content = OLD) {
  useAppStore.setState({ tabs: [makeTab(content)], activeTabId: "t1" });
  await act(async () => { root.render(<Host />); });
  await flush();
}

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  dialogOpen.mockReset(); copySecret.mockClear(); toastInfo.mockReset();
  disk = {
    "C:/keys/id_ed25519": ED25519_PRIV,
    "C:/keys/id_ed25519.pub": ED25519_PUB,
    "C:/keys/id_rsa.pub": RSA_PUB,
    "C:/keys/config": "Host prod\n  User root\n",
    "C:/keys/photo.bin": "\0\0binary",
  };
  useVaultStore.setState({ unlocked: true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const box = this.hasAttribute("data-drop-zone") ? [0, 0, 400, 80] : this.hasAttribute("data-entry-drop") ? [0, 0, 800, 600] : [0, 0, 0, 0];
    const [left, top, right, bottom] = box;
    return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top } as DOMRect;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  clearDropTargets();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SshEntryEditor", () => {
  it("loads an entry saved by an older version unchanged and keeps its fields when edited", async () => {
    await render();
    expect(priv().value).toBe(ED25519_PRIV);
    expect(pub().value).toBe("");
    expect(q("[data-key-files]")).toBeNull();
    // Facts derived from the stored key.
    expect(q('[aria-label="Private key details"]')!.textContent).toContain("ED25519 · 256-bit");
    expect(q('[aria-label="Private key details"]')!.textContent).toContain("alice@laptop");

    await typeInto(q<HTMLInputElement>("#ssh-host")!, "new.example.com");
    const s = stored();
    expect(s.title).toBe("Prod");
    expect(s.fields).toMatchObject({ host: "new.example.com", username: "root", privateKey: ED25519_PRIV, auth: "key", publicKey: "", keyFiles: "" });
  });

  it("masks the private key until Reveal, and hides it again when the window loses focus", async () => {
    await render();
    expect(priv().hasAttribute("data-masked")).toBe(true);
    await click(btn("Show private key"));
    expect(priv().hasAttribute("data-masked")).toBe(false);
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    expect(priv().hasAttribute("data-masked")).toBe(true);
    await click(btn("Show private key"));
    await act(async () => { window.dispatchEvent(new Event(VAULT_HIDE_SECRETS_EVENT)); });
    expect(priv().hasAttribute("data-masked")).toBe(true);
  });

  it("routes imported files: private key and its .pub to their fields, the rest into the list", async () => {
    await render(JSON.stringify({ v: 1, kind: "ssh", title: "New", fields: {} }));
    dialogOpen.mockResolvedValue(["C:/keys/id_rsa.pub", "C:/keys/id_ed25519.pub", "C:/keys/id_ed25519", "C:/keys/config"]);
    await click(byText("Import files"));

    expect(priv().value).toBe(ED25519_PRIV);
    expect(pub().value).toBe(ED25519_PUB.trim());
    const rows = [...document.querySelectorAll("[data-key-file]")].map((r) => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("id_rsa.pub");
    expect(rows[1]).toContain("config");
    expect(live()).toMatch(/id_ed25519 set as the private key; id_ed25519\.pub set as the public key; 2 other files kept below/);
    expect(document.body.textContent).toContain("Matches the private key");
    expect(stored().fields.auth).toBe("key");
  });

  it("imports dropped files and lists the ones it can't read", async () => {
    await render(JSON.stringify({ v: 1, kind: "ssh", title: "New", fields: {} }));
    await act(async () => { expect(dropAt(["C:/keys/id_ed25519", "C:/keys/photo.bin", "C:/keys/folder"], { x: 10, y: 10 }, 1)).toBe(true); });
    await flush();
    expect(priv().value).toBe(ED25519_PRIV);
    const errs = [...document.querySelectorAll("[data-import-error]")].map((e) => e.textContent);
    expect(errs).toHaveLength(2);
    expect(errs[0]).toContain("photo.bin");
    expect(errs[0]).toMatch(/binary/);
    expect(errs[1]).toMatch(/Folders/);
    await click(btn("Dismiss error for photo.bin"));
    expect(document.querySelectorAll("[data-import-error]")).toHaveLength(1);
  });

  it("keeps the replaced key when a new private key is imported", async () => {
    await render(JSON.stringify({ v: 1, kind: "ssh", title: "x", fields: { privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----" } }));
    dialogOpen.mockResolvedValue("C:/keys/id_ed25519");
    await click(byText("Import files"));
    expect(priv().value).toBe(ED25519_PRIV);
    expect(q("[data-key-files]")!.textContent).toContain("Previous private key");
  });

  it("removes a listed file with Undo", async () => {
    const files = [{ id: "a", name: "config", size: 6, value: "Host *" }, { id: "b", name: "id_rsa.pub", size: RSA_PUB.length, value: RSA_PUB }];
    await render(JSON.stringify({ v: 1, kind: "ssh", title: "x", fields: { keyFiles: JSON.stringify(files) } }));
    await click(btn("Remove config"));
    expect(document.querySelectorAll("[data-key-file]")).toHaveLength(1);
    expect(stored().fields.keyFiles).not.toContain("config");
    expect(live()).toMatch(/Removed config/);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("View id_rsa.pub");

    const undo = (toastInfo.mock.calls.at(-1)![1] as { actions: { onClick: () => void }[] }).actions[0];
    await act(async () => { undo.onClick(); });
    await flush();
    const names = [...document.querySelectorAll("[data-key-file]")].map((r) => r.getAttribute("data-key-file"));
    expect(names).toEqual(["a", "b"]);
    expect(live()).toMatch(/Restored config/);
  });

  it("views a listed file in a dialog with Copy, and can promote it to the public key", async () => {
    const files = [{ id: "b", name: "id_rsa.pub", size: RSA_PUB.length, value: RSA_PUB }];
    await render(JSON.stringify({ v: 1, kind: "ssh", title: "x", fields: { privateKey: ED25519_PRIV, keyFiles: JSON.stringify(files) } }));
    await click(btn("View id_rsa.pub"));
    const dlg = q('[data-testid="key-viewer"]')!;
    expect(dlg.textContent).toContain(RSA_PUB.trim());
    expect(dlg.textContent).toContain("RSA · 1024-bit");
    await click([...dlg.querySelectorAll("button")].find((b) => b.textContent?.includes("Copy"))!);
    expect(copySecret).toHaveBeenCalledWith(RSA_PUB, "id_rsa.pub");
    await click([...dlg.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Close")!);
    expect(q('[data-testid="key-viewer"]')).toBeNull();

    await click(btn("Use id_rsa.pub as the public key"));
    expect(pub().value).toBe(RSA_PUB.trim());
    expect(document.querySelectorAll("[data-key-file]")).toHaveLength(0);
    expect(document.body.textContent).toContain("Doesn't match the private key");
  });

  it("shows the public key's fingerprint and moves a public key pasted into the private field", async () => {
    await render(JSON.stringify({ v: 1, kind: "ssh", title: "x", fields: {} }));
    await typeInto(priv(), ED25519_PUB);
    await click(byText("Move to Public key"));
    expect(priv().value).toBe("");
    expect(pub().value).toBe(ED25519_PUB.trim());
    await flush();
    expect(q('[aria-label="Public key details"]')!.textContent).toContain("SHA256:OPf/VexZlelQ627I9gnHnamVBIJOPkKMTHBqMokS3PA");
  });

  it("asks before clearing the private key and can undo it", async () => {
    await render();
    await click(btn("Clear private key"));
    await click(byText("Clear key"));
    expect(priv().value).toBe("");
    const undo = (toastInfo.mock.calls.at(-1)![1] as { actions: { onClick: () => void }[] }).actions[0];
    await act(async () => { undo.onClick(); });
    await flush();
    expect(priv().value).toBe(ED25519_PRIV);
  });

  it("shows the password and the private key together, and keeps both when either is edited", async () => {
    await render(JSON.stringify({ v: 1, kind: "ssh", title: "Prod", fields: { host: "h.io", username: "root", password: "pw1", privateKey: ED25519_PRIV } }));
    // No either/or switch: both fields are on screen at once.
    expect(q("[aria-label=\"Sign-in method\"]")).toBeNull();
    expect(q<HTMLInputElement>("#ssh-pass")!.value).toBe("pw1");
    expect(priv().value).toBe(ED25519_PRIV);

    await typeInto(q<HTMLInputElement>("#ssh-pass")!, "pw2");
    expect(stored().fields).toMatchObject({ password: "pw2", privateKey: ED25519_PRIV });
    await typeInto(priv(), "");
    expect(stored().fields).toMatchObject({ password: "pw2", privateKey: "" });
  });

  it("can add a password to an entry that only had a key", async () => {
    await render();
    expect(q<HTMLInputElement>("#ssh-pass")!.value).toBe("");
    await typeInto(q<HTMLInputElement>("#ssh-pass")!, "added");
    expect(stored().fields).toMatchObject({ password: "added", privateKey: ED25519_PRIV });
  });
});
