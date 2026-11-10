// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { loginChoiceItems, SheetPicker, sheetShowsSearch, SHEET_SEARCH_MIN } from "../components/vault/autofillChoices";
import { emptyLogin } from "../lib/loginEntry";
import type { LoginMatch } from "../lib/autofill";
import { IDLE, step, type Effect, type Job, type PromptEvent, type PromptState } from "./promptMachine";
import {
  canFillAndCopyCode, exactSiteMatch, lastUsedText, loginActionLabel, loginMeta, loginTitle, looseMatchOf,
} from "./sheetCopy";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const login = (i: number, extra: Partial<LoginMatch["entry"]> = {}): LoginMatch => ({
  path: `/v/Logins/${i}.nqv`, rel: `Logins/${i}.nqv`,
  entry: { ...emptyLogin(`Site ${i}`), url: "https://example.com", username: `user${i}`, password: `pw${i}`, ...extra },
});
const logins = (n: number) => Array.from({ length: n }, (_, i) => login(i));

describe("sheet wording and risk signals", () => {
  it("exact vs loose host match (www ignored, extra sites count)", () => {
    const e = login(0, { url: "https://www.example.com/login", urls: ["https://accounts.other.org"] }).entry;
    expect(exactSiteMatch("example.com", e)).toBe(true);
    expect(exactSiteMatch("www.example.com", e)).toBe(true);
    expect(exactSiteMatch("accounts.other.org", e)).toBe(true);
    expect(looseMatchOf("example.com", e)).toBeNull();
    expect(looseMatchOf("login.example.com", e)).toBe("example.com");
    expect(looseMatchOf("sso.accounts.other.org", e)).toBe("accounts.other.org");
  });

  it("last used and the account meta line", () => {
    const now = new Date(2026, 10, 9, 15, 0).getTime();
    expect(lastUsedText(0, now)).toBe("");
    expect(lastUsedText(new Date(2026, 10, 9, 8).getTime(), now)).toBe("last used today");
    expect(lastUsedText(new Date(2026, 10, 8, 23).getTime(), now)).toBe("last used yesterday");
    expect(lastUsedText(new Date(2026, 10, 6, 12).getTime(), now)).toBe("last used 3 days ago");
    expect(loginMeta(login(0, { totp: "JBSWY3DPEHPK3PXP" }), now - 1000, now)).toBe("2FA code ready · last used today");
    expect(loginMeta(login(0), 0, now)).toBe("");
    expect(loginMeta(login(0), now - 1000, now)).toBe("Last used today");
  });

  it("titles and the primary action", () => {
    expect(loginTitle("GitHub", {})).toBe("Sign in to GitHub?");
    expect(loginTitle("GitHub", { intent: "code" })).toBe("Fill 2-step code for GitHub?");
    expect(loginTitle("GitHub", { copy: "password" })).toBe("Copy password for GitHub?");
    expect(loginActionLabel({})).toBe("Fill");
    expect(loginActionLabel({ intent: "code" })).toBe("Fill code");
    expect(loginActionLabel({ copy: "code" })).toBe("Copy 2FA code");
  });

  it("fill-and-copy-2FA only for a login with 2FA, never for a copy request", () => {
    expect(canFillAndCopyCode(login(0, { totp: "JBSWY3DPEHPK3PXP" }), {})).toBe(true);
    expect(canFillAndCopyCode(login(0), {})).toBe(false);
    expect(canFillAndCopyCode(login(0, { totp: "JBSWY3DPEHPK3PXP" }), { copy: "password" })).toBe(false);
    expect(canFillAndCopyCode(undefined, {})).toBe(false);
  });
});

describe("prompt machine: Shift+Enter fill and copy 2FA", () => {
  const job: Job = { kind: "fill", req: { id: "f1", host: "example.com" } };
  const toRequest = (matches: LoginMatch[]): PromptState => {
    let s: PromptState = IDLE;
    for (const ev of [
      { type: "start", job, exists: true, unlocked: true, trusted: false },
      { type: "scanned", matches, lookalike: null },
    ] as PromptEvent[]) s = step(s, ev).state;
    return s;
  };
  const release = (fx: Effect[]) => fx.find((e): e is Extract<Effect, { kind: "release" }> => e.kind === "release");

  it("marks the release only when the login has a 2FA secret", () => {
    const withCode = toRequest([login(0, { totp: "JBSWY3DPEHPK3PXP" }), login(1)]);
    expect(release(step(withCode, { type: "allow", copyCode: true }).effects)?.copyCode).toBe(true);
    expect(release(step(withCode, { type: "allow" }).effects)?.copyCode).toBeUndefined();
    const picked = step(withCode, { type: "pick", index: 1 }).state;
    expect(release(step(picked, { type: "allow", copyCode: true }).effects)?.copyCode).toBeUndefined();
  });
});

// ── SheetPicker ─────────────────────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

const key = (el: Element, k: string, o: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o }));
const flushRaf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function Harness({ n, onAllow, onDetails, onChosen }: {
  n: number; onAllow?: (i: number) => void; onDetails?: (i: number) => void; onChosen?: () => void;
}) {
  const [pick, setPick] = useState(0);
  const [query, setQuery] = useState("");
  const matches = logins(n);
  return (
    <div role="alertdialog">
      <SheetPicker label="Saved logins" noun="logins" items={loginChoiceItems(matches, () => 0)} pick={pick} onPick={setPick}
                   onAllow={onAllow} onDetails={onDetails} query={query} onQuery={setQuery} onChosen={onChosen} />
      <output data-testid="pick">{pick}</output>
    </div>
  );
}
const pickNow = () => Number(host.querySelector('[data-testid="pick"]')!.textContent);
const toggle = () => host.querySelector<HTMLButtonElement>("button.af-acct-main");
const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')];

describe("sheet picker", () => {
  it("one login: a plain row, no chevron, no list", async () => {
    await act(async () => { root.render(<Harness n={1} />); });
    expect(toggle()).toBeNull();
    expect(host.querySelector(".af-acct-main[data-single]")?.textContent).toContain("Site 0");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it("several: the chevron button opens a listbox with the selected option checked", async () => {
    await act(async () => { root.render(<Harness n={3} />); });
    const t = toggle()!;
    expect(t.getAttribute("aria-haspopup")).toBe("listbox");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { t.click(); });
    expect(t.getAttribute("aria-expanded")).toBe("true");
    expect(t.getAttribute("aria-controls")).toBe("af-acct-list");
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(document.activeElement).toBe(options()[0]);
    expect(host.querySelector('input[aria-label="Search logins"]')).toBeNull(); // fewer than 5
  });

  it("choosing an option only selects it (no fill), closes the list and hands the focus on", async () => {
    const onAllow = vi.fn();
    const onChosen = vi.fn();
    await act(async () => { root.render(<Harness n={3} onAllow={onAllow} onChosen={onChosen} />); });
    await act(async () => { toggle()!.click(); });
    await act(async () => { key(options()[0], "ArrowDown"); });
    expect(document.activeElement).toBe(options()[1]);
    await act(async () => { key(options()[1], "Enter"); });
    await act(async () => { await flushRaf(); });
    expect(pickNow()).toBe(1);
    expect(onAllow).not.toHaveBeenCalled();
    expect(onChosen).toHaveBeenCalled();
    expect(options()).toHaveLength(0);
  });

  it("Escape in the list closes it without reaching the window", async () => {
    const onWindowEsc = vi.fn();
    window.addEventListener("keydown", onWindowEsc);
    await act(async () => { root.render(<Harness n={3} />); });
    await act(async () => { toggle()!.click(); });
    await act(async () => { key(options()[0], "Escape"); });
    window.removeEventListener("keydown", onWindowEsc);
    expect(options()).toHaveLength(0);
    expect(onWindowEsc).not.toHaveBeenCalled();
  });

  it("double-click on an option picks it and allows", async () => {
    const onAllow = vi.fn();
    await act(async () => { root.render(<Harness n={3} onAllow={onAllow} />); });
    await act(async () => { toggle()!.click(); });
    await act(async () => { options()[2].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(onAllow).toHaveBeenCalledWith(2);
    expect(pickNow()).toBe(2);
  });

  it(`search appears from ${SHEET_SEARCH_MIN} logins, filters and announces`, async () => {
    expect(sheetShowsSearch(SHEET_SEARCH_MIN - 1)).toBe(false);
    expect(sheetShowsSearch(SHEET_SEARCH_MIN)).toBe(true);
    await act(async () => { root.render(<Harness n={SHEET_SEARCH_MIN} />); });
    await act(async () => { toggle()!.click(); });
    const box = host.querySelector<HTMLInputElement>('input[aria-label="Search logins"]')!;
    expect(document.activeElement).toBe(box);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, "user3");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining("Site 3")]);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(host.querySelector('[role="status"]')?.textContent).toBe("1 of 5 logins");
    // Enter in the search box only moves to the option: nothing is chosen or filled.
    await act(async () => { key(box, "Enter"); });
    expect(document.activeElement).toBe(options()[0]);
    expect(pickNow()).toBe(0);
  });

  it("the details button opens the selected entry", async () => {
    const onDetails = vi.fn();
    await act(async () => { root.render(<Harness n={2} onDetails={onDetails} />); });
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-af-details]")!.click(); });
    expect(onDetails).toHaveBeenCalledWith(0);
  });
});
