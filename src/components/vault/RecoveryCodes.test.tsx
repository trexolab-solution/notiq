// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
const vaultWriteFile = vi.fn(async (_path: string, _content: string, _ext: string) => {});
vi.mock("../../lib/vault", async (orig) => ({
  ...(await orig<typeof import("../../lib/vault")>()),
  isVaultPath: () => true,
  vaultWriteFile: (p: string, c: string, e: string) => vaultWriteFile(p, c, e),
  vaultAttachList: async () => [],
}));
vi.mock("../../lib/attachmentLimits", async (orig) => ({
  ...(await orig<typeof import("../../lib/attachmentLimits")>()),
  vaultAttachmentsUsed: async () => 0,
}));
vi.mock("../../lib/vaultDir", () => ({ resolveVaultDir: async () => "C:/vault" }));
vi.mock("../../lib/entrySync", () => ({ planEntryRename: async () => null }));
vi.mock("../../lib/session", async (orig) => ({ ...(await orig<typeof import("../../lib/session")>()), saveSession: async () => {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RecoveryCodesEditor } = await import("./RecoveryCodesEditor");
const { LoginEntryEditor } = await import("./LoginEntryEditor");
const { useAppStore } = await import("../../store");
const { useVaultStore } = await import("../../store/vaultStore");
const { getCodeDraft } = await import("../../lib/codeDrafts");
const { setEntryEditing } = await import("../../lib/entryUi");
const { emptyCodes, serializeCodes, parseCodes, MAX_CODES } = await import("../../lib/recoveryCodes");
const { emptyLogin, serializeLogin, parseLogin } = await import("../../lib/loginEntry");
type Tab = import("../../types").Tab;

let host: HTMLDivElement;
let root: Root;
const tab = () => useAppStore.getState().tabs[0];
const box = () => document.querySelector<HTMLTextAreaElement>("#rc-add")!;

function Host({ Editor }: { Editor: (p: { tab: Tab }) => React.ReactNode }) {
  const t = useAppStore((s) => s.tabs[0]);
  return t ? <Editor tab={t} /> : null;
}

async function render(ext: string, content: string, Editor: (p: { tab: Tab }) => React.ReactNode) {
  const t = { id: "t1", title: "A.nqv", filePath: "C:/vault/A.nqv", content, isDirty: false, vaultExt: ext, kind: "note" } as unknown as Tab;
  setEntryEditing("t1", true);
  useAppStore.setState({ tabs: [t], activeTabId: "t1" });
  await act(async () => { root.render(<Host Editor={Editor} />); });
}

async function paste(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), text);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const save = () => act(async () => { await useAppStore.getState().saveTabToFile("t1"); });
const written = () => vaultWriteFile.mock.calls[vaultWriteFile.mock.calls.length - 1][1];

beforeEach(() => {
  vaultWriteFile.mockClear();
  useVaultStore.setState({ ensureUnlocked: async () => true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  useAppStore.getState().removeTab("t1");
  host.remove();
});

describe("recovery codes waiting in the box", () => {
  it("marks the tab unsaved, and Save stores them without pressing Add codes", async () => {
    await render("codes", serializeCodes(emptyCodes("A")), RecoveryCodesEditor);
    await paste("aaa-111\nbbb-222");
    expect(tab().isDirty).toBe(true);
    await save();
    expect(parseCodes(written()).codes.map((c) => c.code)).toEqual(["aaa-111", "bbb-222"]);
    expect(getCodeDraft("t1")).toBe("");
    expect(tab().isDirty).toBe(false);
    // Saved: back to view mode, so there is no box any more and the fields are locked.
    expect(box()).toBeNull();
    expect(document.querySelector<HTMLInputElement>("#rc-title")!.readOnly).toBe(true);
  });

  it("stores them on a login, keeping its other fields", async () => {
    await render("login", serializeLogin({ ...emptyLogin("A"), password: "pw" }), LoginEntryEditor);
    await paste("ccc-333");
    await save();
    const e = parseLogin(written());
    expect(e.password).toBe("pw");
    expect(e.recovery).toEqual([{ code: "ccc-333", used: false }]);
  });

  it("keeps codes that don't fit in the box and leaves the tab unsaved", async () => {
    const full = { ...emptyCodes("A"), codes: Array.from({ length: MAX_CODES }, (_, i) => ({ code: `c${i}`, used: false })) };
    await render("codes", serializeCodes(full), RecoveryCodesEditor);
    await paste("extra-1");
    await save();
    expect(getCodeDraft("t1")).toBe("extra-1");
    expect(tab().isDirty).toBe(true);
  });

  it("forgets them when the tab is closed", async () => {
    await render("codes", serializeCodes(emptyCodes("A")), RecoveryCodesEditor);
    await paste("aaa-111");
    await act(async () => { useAppStore.getState().removeTab("t1"); });
    expect(getCodeDraft("t1")).toBe("");
  });
});

describe("remembered section", () => {
  it("shows the same section after the form has been away", async () => {
    const content = serializeLogin(emptyLogin("A"));
    await render("login", content, LoginEntryEditor);
    const section = () => document.querySelector('[data-section-nav] [aria-current="page"]')!.textContent;
    const security = [...document.querySelectorAll<HTMLButtonElement>("[data-section-nav] button")].find((b) => b.textContent === "Security")!;
    await act(async () => { security.click(); });
    await act(async () => { root.render(<p>a note tab</p>); });
    await act(async () => { root.render(<Host Editor={LoginEntryEditor} />); });
    expect(section()).toBe("Security");
  });
});

describe("login recovery codes", () => {
  it("are left out when there are none, and survive a round trip", () => {
    expect(parseLogin(serializeLogin(emptyLogin("A")))).not.toHaveProperty("recovery");
    const e = { ...emptyLogin("A"), recovery: [{ code: "x", used: true }] };
    expect(parseLogin(serializeLogin(e)).recovery).toEqual(e.recovery);
  });
});
