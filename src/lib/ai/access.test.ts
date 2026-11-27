import { describe, expect, it, vi, beforeEach } from "vitest";

const state = { tabs: [] as unknown[], activeTabId: "plain" as string | null };
vi.mock("../../store", () => ({ useAppStore: { getState: () => state } }));

const { aiBlockedFor, aiTypesAlong, allowAiFor, isVaultTab, tabOfModel } = await import("./access");
const { suggestionOptions } = await import("../monacoOptions");

const plain = { id: "plain", title: "Note", filePath: "C:/n/a.md" };
const secret = { id: "secret", title: "Bank", filePath: "C:/v/Bank.nqv", vaultExt: "md" };
const model = (id: string) => ({ uri: { path: `/${id}` } });

beforeEach(() => { state.tabs = [plain, secret]; state.activeTabId = "plain"; });

describe("AI never reads the vault", () => {
  it("knows a vault tab by its path, its type or its lock", () => {
    expect(isVaultTab(secret)).toBe(true);
    expect(isVaultTab({ filePath: "C:/n/a.md", vaultLocked: true })).toBe(true);
    expect(isVaultTab({ vaultExt: "login" })).toBe(true);
    expect(isVaultTab(plain)).toBe(false);
  });

  it("judges text by the tab it belongs to, whatever is on screen", () => {
    expect(aiBlockedFor(model("secret"))).toBe(true); // vault text, plain tab on screen
    state.activeTabId = "secret";
    expect(aiBlockedFor(model("plain"))).toBe(false); // plain text, vault tab on screen
    expect(tabOfModel(model("plain"))?.title).toBe("Note");
  });

  it("keeps away from every editor that is not a tab, unless that one was allowed", () => {
    const remoteFile = model("home/alice/.env"); // the file manager's editor, with an ordinary tab on screen
    expect(aiBlockedFor(remoteFile)).toBe(true);
    const sticky = model("sticky");
    expect(aiBlockedFor(sticky)).toBe(true);
    allowAiFor(sticky);
    expect(aiBlockedFor(sticky)).toBe(false);
    expect(aiBlockedFor(remoteFile)).toBe(true);
    expect(aiBlockedFor(null)).toBe(true);
  });
});

describe("the editor's own suggestions", () => {
  const on = { aiEnabled: true, aiAutocompleteEnabled: true, aiModel: "m", aiTriggerMode: "auto" };

  it("are on whenever AI isn't suggesting as you type", () => {
    expect(aiTypesAlong(on)).toBe(true);
    for (const off of [{ aiEnabled: false }, { aiAutocompleteEnabled: false }, { aiModel: "" }, { aiTriggerMode: "manual" }]) {
      expect(aiTypesAlong({ ...on, ...off }), JSON.stringify(off)).toBe(false);
    }
    expect(suggestionOptions(false)).toEqual({ quickSuggestions: { other: true, comments: false, strings: false }, wordBasedSuggestions: "currentDocument" });
    expect(suggestionOptions(true)).toEqual({ quickSuggestions: false, wordBasedSuggestions: "off" });
  });
});
