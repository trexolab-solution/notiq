// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CardChoice, fillAllowLabel, FillChoice, filterChoices, loginChoiceItems, SEARCH_THRESHOLD, cardChoiceItems,
} from "../components/vault/autofillChoices";
import { avatarTone, initialOf } from "../components/ui/Avatar";
import { emptyLogin } from "../lib/loginEntry";
import { emptySecret } from "../lib/secretEntry";
import type { CardMatch, LoginMatch } from "../lib/autofill";
import type { StoredPasskey } from "../lib/passkeyEntry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

const NAMES = ["Alex Morgan", "Bank", "Chat", "Docs", "Email", "Forum", "Git", "Home"];
const login = (i: number, extra: Partial<LoginMatch["entry"]> = {}): LoginMatch => ({
  path: `/v/Logins/${i}.nqv`, rel: `Logins/${i}.nqv`,
  entry: { ...emptyLogin(NAMES[i]), url: "https://example.com", username: `user${i}`, password: `pw${i}`, ...extra },
});
const logins = (n: number) => Array.from({ length: n }, (_, i) => login(i));

const radios = () => [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
const checked = () => radios().find((r) => r.getAttribute("aria-checked") === "true");
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const search = () => host.querySelector<HTMLInputElement>('input[aria-label="Search logins"]');
const type = (el: HTMLInputElement, value: string) => {
  // React tracks the input's value: set it through the native setter so the change event is seen.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

/** The list with real pick / search state, inside a dialog with a Deny button (as in the window). */
function Harness({ matches, onAllow, onDetails, disabled, initial = 0 }: {
  matches: LoginMatch[]; onAllow?: (i: number) => void; onDetails?: (i: number) => void; disabled?: boolean; initial?: number;
}) {
  const [pick, setPick] = useState(initial);
  const [query, setQuery] = useState("");
  return (
    <div role="alertdialog">
      <FillChoice host="example.com" matches={matches} pick={pick} onPick={setPick} trust={false} onTrust={() => {}}
                  onAllow={onAllow} onDetails={onDetails} disabled={disabled} query={query} onQuery={setQuery} lastUsedOf={() => 0} />
      <button type="button" data-testid="deny">Deny</button>
      <output data-testid="pick">{pick}</output>
    </div>
  );
}
const pickNow = () => Number(host.querySelector('[data-testid="pick"]')!.textContent);

describe("shared pieces", () => {
  it("letter avatar: first letter or digit, scheme and www skipped, stable tint", () => {
    expect(initialOf("alex.morgan")).toBe("A");
    expect(initialOf("https://www.example.com/login")).toBe("E");
    expect(initialOf("  42 Bank")).toBe("4");
    expect(initialOf("ångström")).toBe("Å");
    expect(initialOf("—")).toBe("?");
    expect(avatarTone("Bank")).toBe(avatarTone("bank"));
  });

  it("search matches every word, case-insensitively, in order", () => {
    expect(filterChoices(["Alex Morgan alex@x", "Bank user1", "Chat alex"], "ALEX")).toEqual([0, 2]);
    expect(filterChoices(["Alex Morgan alex@x", "Bank user1", "Chat alex"], "alex chat")).toEqual([2]);
    expect(filterChoices(["a", "b"], "  ")).toEqual([0, 1]);
  });

  it("login badges: Last used (only with a choice), 2FA, Passkey", () => {
    const pk = { rpId: "example.com" } as StoredPasskey;
    const list = [login(0), login(1, { totp: "JBSWY3DPEHPK3PXP" }), login(2, { passkeys: [pk] })];
    const items = loginChoiceItems(list, (m) => (m.path.endsWith("/2.nqv") ? 200 : m.path.endsWith("/0.nqv") ? 100 : 0));
    expect(items.map((i) => i.badges?.map((b) => b.label))).toEqual([[], ["2FA"], ["Last used", "Passkey"]]);
    expect(loginChoiceItems([login(0)], () => 100)[0].badges).toEqual([]);
  });

  it("an expired card gets a badge; the number is never in a row", () => {
    const card: CardMatch = { path: "/v/c.nqv", rel: "c.nqv", entry: emptySecret("card", "Visa"),
                              fill: { name: "A", number: "4111111111111111", exp_month: "01", exp_year: "2001", csc: "123" } };
    const [item] = cardChoiceItems([card]);
    expect(item.badges?.map((b) => b.label)).toEqual(["Expired"]);
    expect(String(item.sub)).not.toContain("4111111111111111");
    expect(String(item.sub)).toContain("1111");
  });

  it("the primary button names who gets filled", () => {
    expect(fillAllowLabel(login(0), {})).toBe("Fill as user0");
    expect(fillAllowLabel(login(0, { username: "" }), {})).toBe("Fill Alex Morgan");
    expect(fillAllowLabel(login(0), { intent: "code" })).toBe("Fill code for user0");
    expect(fillAllowLabel(login(0), { copy: "password" })).toBe("Copy password");
    expect(fillAllowLabel(undefined, {})).toBe("Allow");
  });
});

describe("chooser: rows and keyboard", () => {
  it("rows: avatar, bold title, muted username; the selected row is marked; one Tab stop", async () => {
    await act(async () => { root.render(<Harness matches={logins(3)} initial={1} />); });
    expect(radios().map((r) => r.querySelector(".af-row-title")?.textContent)).toEqual(["Alex Morgan", "Bank", "Chat"]);
    expect(radios()[0].querySelector(".af-row-sub")?.textContent).toBe("user0");
    expect(radios()[0].querySelector(".nq-avatar")?.textContent).toBe("A");
    expect(checked()).toBe(radios()[1]);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(host.querySelector(".af-row[data-selected]")?.contains(radios()[1])).toBe(true);
  });

  it("the whole row is clickable", async () => {
    await act(async () => { root.render(<Harness matches={logins(3)} />); });
    await act(async () => { radios()[2].querySelector<HTMLElement>(".af-row-sub")!.click(); });
    expect(pickNow()).toBe(2);
  });

  it("↑ / ↓ move the selection and the focus (wrapping); Home / End jump", async () => {
    await act(async () => { root.render(<Harness matches={logins(3)} />); });
    radios()[0].focus();
    await act(async () => { key(radios()[0], "ArrowDown"); });
    expect(pickNow()).toBe(1);
    expect(document.activeElement).toBe(radios()[1]);
    await act(async () => { key(radios()[1], "ArrowDown"); });
    await act(async () => { key(radios()[2], "ArrowDown"); });
    expect(pickNow()).toBe(0); // wrapped
    await act(async () => { key(radios()[0], "ArrowUp"); });
    expect(pickNow()).toBe(2);
    await act(async () => { key(radios()[2], "Home"); });
    expect(pickNow()).toBe(0);
    await act(async () => { key(radios()[0], "End"); });
    expect(pickNow()).toBe(2);
  });

  it("↓ on Deny (where the focus starts) goes to the selected row without moving it", async () => {
    await act(async () => { root.render(<Harness matches={logins(3)} initial={1} />); });
    const deny = host.querySelector<HTMLButtonElement>('[data-testid="deny"]')!;
    deny.focus();
    await act(async () => { key(deny, "ArrowDown"); });
    expect(document.activeElement).toBe(radios()[1]);
    expect(pickNow()).toBe(1);
  });

  it("Enter on a row allows that row; Space only picks", async () => {
    const onAllow = vi.fn();
    await act(async () => { root.render(<Harness matches={logins(3)} onAllow={onAllow} />); });
    await act(async () => { key(radios()[2], " "); });
    expect(pickNow()).toBe(2);
    expect(onAllow).not.toHaveBeenCalled();
    await act(async () => { key(radios()[2], "Enter"); });
    expect(onAllow).toHaveBeenCalledWith(2);
  });

  it("double-click allows that row right away", async () => {
    const onAllow = vi.fn();
    await act(async () => { root.render(<Harness matches={logins(3)} onAllow={onAllow} />); });
    await act(async () => { radios()[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(pickNow()).toBe(1);
    expect(onAllow).toHaveBeenCalledWith(1);
  });

  it("the details button neither picks the row nor allows, even on double-click", async () => {
    const onAllow = vi.fn();
    const onDetails = vi.fn();
    await act(async () => { root.render(<Harness matches={logins(3)} onAllow={onAllow} onDetails={onDetails} />); });
    const btn = host.querySelector<HTMLButtonElement>('[data-af-details="2"]')!;
    expect(btn.getAttribute("aria-label")).toBe("View details of Chat");
    // Only the selected row's button is a Tab stop; the others are still reachable once their row is picked.
    expect(btn.tabIndex).toBe(-1);
    expect(host.querySelector<HTMLButtonElement>('[data-af-details="0"]')!.tabIndex).toBe(0);
    await act(async () => { btn.click(); btn.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(onDetails).toHaveBeenCalledWith(2);
    expect(onAllow).not.toHaveBeenCalled();
    expect(pickNow()).toBe(0);
  });

  it("busy: rows can't be picked or allowed", async () => {
    const onAllow = vi.fn();
    await act(async () => { root.render(<Harness matches={logins(3)} onAllow={onAllow} disabled />); });
    await act(async () => {
      radios()[2].click();
      key(radios()[0], "ArrowDown");
      key(radios()[0], "Enter");
      radios()[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(pickNow()).toBe(0);
    expect(onAllow).not.toHaveBeenCalled();
  });
});

describe("chooser: search", () => {
  it(`no search box with ${SEARCH_THRESHOLD} or fewer matches`, async () => {
    await act(async () => { root.render(<Harness matches={logins(SEARCH_THRESHOLD)} />); });
    expect(search()).toBeNull();
  });

  it("more than 5 matches: the search box is there and has the focus first", async () => {
    await act(async () => { root.render(<Harness matches={logins(8)} />); });
    expect(search()).toBeTruthy();
    expect(document.activeElement).toBe(search());
    expect(search()!.placeholder).toBe("Search 8 logins…");
  });

  it("typing filters (title, username, site) and keeps the selection on a visible row", async () => {
    await act(async () => { root.render(<Harness matches={logins(8)} />); });
    await act(async () => { type(search()!, "git"); });
    expect(radios().map((r) => r.querySelector(".af-row-title")?.textContent)).toEqual(["Git"]);
    expect(pickNow()).toBe(6);
    await act(async () => { type(search()!, "user3"); });
    expect(pickNow()).toBe(3);
  });

  it("↑ / ↓ in the search move the selection; Enter only moves the focus to the row (never allows)", async () => {
    const onAllow = vi.fn();
    await act(async () => { root.render(<Harness matches={logins(8)} onAllow={onAllow} />); });
    await act(async () => { key(search()!, "ArrowDown"); });
    await act(async () => { key(search()!, "ArrowDown"); });
    expect(pickNow()).toBe(2);
    expect(document.activeElement).toBe(search());
    await act(async () => { key(search()!, "Enter"); });
    expect(onAllow).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(radios()[2]);
  });

  it("Escape in a search with text clears it and doesn't reach the window (Deny)", async () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      await act(async () => { root.render(<Harness matches={logins(8)} />); });
      await act(async () => { type(search()!, "zzz"); });
      await act(async () => { key(search()!, "Escape"); });
      expect(search()!.value).toBe("");
      expect(onWindowKey).not.toHaveBeenCalled();
      // Empty search: Escape is the window's again.
      await act(async () => { key(search()!, "Escape"); });
      expect(onWindowKey).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("no match: an empty state with a way back", async () => {
    await act(async () => { root.render(<Harness matches={logins(8)} />); });
    await act(async () => { type(search()!, "nothing-like-this"); });
    expect(radios()).toHaveLength(0);
    expect(host.querySelector(".af-empty")?.textContent).toContain("No logins match “nothing-like-this”");
    const clear = [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear search")!;
    await act(async () => { clear.click(); });
    expect(radios()).toHaveLength(8);
  });

  it("cards are searchable too (by title and last digits)", async () => {
    const cards: CardMatch[] = Array.from({ length: 6 }, (_, i) => ({
      path: `/v/c${i}.nqv`, rel: `c${i}.nqv`, entry: emptySecret("card", `Card ${i}`),
      fill: { name: "", number: `411111111111${1000 + i}`, exp_month: "", exp_year: "", csc: "" },
    }));
    function Cards() {
      const [pick, setPick] = useState(0);
      const [q, setQ] = useState("");
      return <CardChoice cards={cards} pick={pick} onPick={setPick} query={q} onQuery={setQ} />;
    }
    await act(async () => { root.render(<Cards />); });
    const box = host.querySelector<HTMLInputElement>('input[aria-label="Search cards"]')!;
    await act(async () => { type(box, "1004"); });
    expect(radios().map((r) => r.querySelector(".af-row-title")?.textContent)).toEqual(["Card 4"]);
  });
});
