// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EntryDetailsView, MASK } from "./EntryDetailsView";
import { CardChoice, FillChoice, IdentityChoice } from "../components/vault/autofillBodies";
import { detailsFromFile, loadEntryDetails, loginDetails, secretDetails, type DetailsDeps } from "../lib/entryDetails";
import { ERR_LOCKED, type VaultFile } from "../lib/vault";
import { emptyLogin, serializeLogin, type LoginEntry } from "../lib/loginEntry";
import { emptySecret } from "../lib/secretEntry";
import type { CardMatch, IdentityMatch, LoginMatch } from "../lib/autofill";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

const login: LoginEntry = {
  ...emptyLogin("Bank"), url: "https://bank.example", urls: ["bank.example.co.uk"], username: "me", password: "hunter22",
  totp: "JBSWY3DPEHPK3PXP", notes: "Branch 12",
  custom: [{ label: "Customer ID", value: "C-42", secret: false }, { label: "PIN", value: "9876", secret: true }, { label: "", value: "", secret: false }],
};
const loginFile: VaultFile = { ext: "login", content: serializeLogin(login) };
const deps = (file: VaultFile, unlocked = true): DetailsDeps & { read: ReturnType<typeof vi.fn> } => ({
  status: async () => ({ exists: true, unlocked }),
  read: vi.fn(async () => file),
});

describe("entry details model", () => {
  it("login: sites, username, password (secret), custom fields, 2-step secret and notes", () => {
    const d = loginDetails(login);
    expect(d.title).toBe("Bank");
    expect(d.sites).toEqual(["https://bank.example", "bank.example.co.uk"]);
    expect(d.rows.map((r) => [r.label, r.secret])).toEqual([
      ["Username", false], ["Password", true], ["Customer ID", false], ["PIN", true],
    ]);
    expect(d.totp).toBe("JBSWY3DPEHPK3PXP");
    expect(d.notes).toBe("Branch 12");
  });

  it("card: non-empty schema fields, secrets flagged, number shown grouped but copied raw", () => {
    const card = { ...emptySecret("card", ""), fields: { cardholder: "A Kumar", number: "4111111111111111", expiry: "12/30", cvv: "123", pin: "", zip: "", notes: "n" } };
    const d = secretDetails(card);
    expect(d.title).toBe("A Kumar");
    expect(d.rows.map((r) => r.id)).toEqual(["cardholder", "number", "expiry", "cvv"]);
    const num = d.rows.find((r) => r.id === "number")!;
    expect(num).toMatchObject({ secret: true, value: "4111111111111111", display: "4111 1111 1111 1111" });
    expect(d.rows.find((r) => r.id === "cvv")!.secret).toBe(true);
    expect(d.notes).toBe("n");
  });

  it("notes and unknown kinds are not shown", () => {
    expect(detailsFromFile({ ext: "md", content: "# hi" })).toBeNull();
  });

  it("a locked vault is never read", async () => {
    const dp = deps(loginFile, false);
    await expect(loadEntryDetails("/v/Logins/bank.nqv", dp)).rejects.toBe(ERR_LOCKED);
    expect(dp.read).not.toHaveBeenCalled();
  });

  it("reads the entry fresh by its path when unlocked", async () => {
    const dp = deps(loginFile);
    const d = await loadEntryDetails("/v/Logins/bank.nqv", dp);
    expect(dp.read).toHaveBeenCalledWith("/v/Logins/bank.nqv");
    expect(d.rows[0].value).toBe("me");
  });
});

describe("choice rows: details quick action", () => {
  const m = (rel: string, title: string): LoginMatch => ({ path: `/v/${rel}`, rel, entry: { ...emptyLogin(title), username: "u" } });
  const matches = [m("Logins/a.nqv", "Alpha"), m("Logins/b.nqv", "Beta")];

  it("opens details for its row without picking the row", async () => {
    const onPick = vi.fn();
    const onDetails = vi.fn();
    await act(async () => {
      root.render(<FillChoice host="x.example" matches={matches} pick={0} onPick={onPick} trust={false} onTrust={() => {}} onDetails={onDetails} />);
    });
    const btn = host.querySelector<HTMLButtonElement>('button[aria-label="View details of Beta"]')!;
    expect(btn).toBeTruthy();
    await act(async () => { btn.click(); });
    expect(onDetails).toHaveBeenCalledWith(1);
    expect(onPick).not.toHaveBeenCalled();
    expect(host.querySelectorAll<HTMLElement>('[role="radio"]')[0].getAttribute("aria-checked")).toBe("true");
  });

  it("no details button without onDetails (main-window fallback dialog)", async () => {
    await act(async () => {
      root.render(<FillChoice host="x.example" matches={matches} pick={0} onPick={() => {}} trust={false} onTrust={() => {}} />);
    });
    expect(host.querySelector(".af-details-btn")).toBeNull();
  });

  it("cards and identities get it too", async () => {
    const card: CardMatch = { path: "/v/c.nqv", rel: "c.nqv", entry: emptySecret("card", "Visa"),
                              fill: { name: "", number: "4111111111111111", exp_month: "", exp_year: "", csc: "" } };
    const id: IdentityMatch = { path: "/v/i.nqv", rel: "i.nqv", entry: emptySecret("identity", "Home"), fill: { name: "A" } as IdentityMatch["fill"] };
    const onDetails = vi.fn();
    await act(async () => {
      root.render(<>
        <CardChoice cards={[card]} pick={0} onPick={() => {}} onDetails={onDetails} />
        <IdentityChoice identities={[id]} pick={0} onPick={() => {}} onDetails={onDetails} />
      </>);
    });
    expect(host.querySelectorAll(".af-details-btn")).toHaveLength(2);
  });
});

describe("details view", () => {
  async function render(dp: DetailsDeps, extra: Partial<Parameters<typeof EntryDetailsView>[0]> = {}) {
    await act(async () => { root.render(<EntryDetailsView path="/v/Logins/bank.nqv" onBack={() => {}} deps={dp} {...extra} />); });
    await act(async () => { await Promise.resolve(); });
  }
  const val = (id: string) => host.querySelector(`[data-testid="af-dval-${id}"]`)?.textContent;

  it("shows every value with a copy button; secrets masked until revealed", async () => {
    await render(deps(loginFile));
    expect(host.textContent).toContain("Bank");
    expect(val("site-0")).toBe("https://bank.example");
    expect(val("username")).toBe("me");
    expect(val("password")).toBe(MASK);
    expect(val("custom-0")).toBe("C-42");
    expect(val("custom-1")).toBe(MASK);
    expect(host.textContent).not.toContain("hunter22");
    expect(host.textContent).not.toContain("9876");
    expect(host.textContent).not.toContain("JBSWY3DPEHPK3PXP");
    expect(val("site-1")).toBe("bank.example.co.uk");
    for (const label of ["website bank.example", "website bank.example.co.uk", "Username", "Password", "Customer ID", "PIN", "2-step code", "Notes"]) {
      expect(host.querySelector(`button[aria-label="Copy ${label}"]`), label).toBeTruthy();
    }
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Show Password"]')!.click(); });
    expect(val("password")).toBe("hunter22");
    expect(val("custom-1")).toBe(MASK); // each secret is revealed on its own
  });

  it("shows the live 2-step code, never the secret", async () => {
    await render(deps(loginFile));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(val("totp")).toMatch(/^\d{3} \d{3}$/);
    expect(host.querySelector('[data-testid="af-totp-left"]')?.textContent).toMatch(/^\d+s$/);
    expect(host.querySelector("[data-totp-ring]")).toBeTruthy();
  });

  it("revealed secrets hide again when the window loses focus", async () => {
    await render(deps(loginFile));
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Show PIN"]')!.click(); });
    expect(val("custom-1")).toBe("9876");
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    expect(val("custom-1")).toBe(MASK);
  });

  it("locked vault: an error, nothing read", async () => {
    const dp = deps(loginFile, false);
    await render(dp);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("locked");
    expect(dp.read).not.toHaveBeenCalled();
  });

  it("Back and Open in Notiq call back; Back has the focus", async () => {
    const onBack = vi.fn();
    const onOpen = vi.fn();
    await render(deps(loginFile), { onBack, onOpen });
    const back = host.querySelector<HTMLButtonElement>('button[aria-label="Back to the list"]')!;
    expect(document.activeElement).toBe(back);
    await act(async () => { back.click(); });
    expect(onBack).toHaveBeenCalled();
    const open = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Open in Notiq"))!;
    await act(async () => { open.click(); });
    expect(onOpen).toHaveBeenCalled();
  });

  it("no Open in Notiq without a way to open the entry", async () => {
    await render(deps(loginFile));
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("Open in Notiq"))).toBe(false);
  });

  it("header: avatar, title and site; the list's title is shown while the entry is read", async () => {
    let release: (f: VaultFile) => void = () => {};
    const slow: DetailsDeps = { status: async () => ({ exists: true, unlocked: true }), read: () => new Promise((r) => { release = r; }) };
    await act(async () => { root.render(<EntryDetailsView path="/v/Logins/bank.nqv" title="Bank (list)" onBack={() => {}} deps={slow} />); });
    expect(host.querySelector(".af-details-title")?.textContent).toBe("Bank (list)");
    await act(async () => { release(loginFile); await Promise.resolve(); });
    expect(host.querySelector(".af-details-title")?.textContent).toBe("Bank");
    expect(host.querySelector(".af-details-sub")?.textContent).toBe("bank.example");
    expect(host.querySelector(".af-details-head .nq-avatar")?.textContent).toBe("B");
  });

  it("layout: websites as a list, notes in their own scrolling box, one action column per row", async () => {
    await render(deps(loginFile));
    expect(host.querySelectorAll('ul[aria-label="Websites"] > li')).toHaveLength(2);
    expect(host.querySelector(".af-notes")?.textContent).toBe("Branch 12");
    // Every row ends in the same two slots (reveal or a spacer, then copy), so the edges line up.
    for (const li of host.querySelectorAll('ul[aria-label="Fields"] > li, ul[aria-label="Custom fields"] > li')) {
      expect(li.lastElementChild!.children.length, li.textContent ?? "").toBe(2);
    }
  });

  it("Fill this login: calls back once, reads nothing more, never shows the secret", async () => {
    const onFill = vi.fn();
    const onBack = vi.fn();
    const dp = deps(loginFile);
    await render(dp, { onFill, onBack });
    const fill = [...host.querySelectorAll("button")].find((b) => b.textContent === "Fill this login")!;
    await act(async () => { fill.click(); });
    expect(onFill).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    expect(dp.read).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("hunter22");
  });

  it("while filling: the button spins and Back / Open are disabled", async () => {
    await render(deps(loginFile), { onFill: () => {}, onOpen: () => {}, busy: true });
    const fill = host.querySelector<HTMLButtonElement>(".af-fill-btn")!;
    expect(fill.disabled).toBe(true);
    expect(fill.textContent).toBe("Filling…");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Back to the list"]')!.disabled).toBe(true);
    expect([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Open in Notiq"))!.disabled).toBe(true);
  });

  it("security: nothing is read before the view opens, and a reveal does not survive Back", async () => {
    const dp = deps(loginFile);
    const choice = <FillChoice host="bank.example" matches={[{ path: "/v/Logins/bank.nqv", rel: "Logins/bank.nqv", entry: login }]}
                               pick={0} onPick={() => {}} trust={false} onTrust={() => {}} onDetails={() => {}} />;
    await act(async () => { root.render(choice); });
    expect(dp.read).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("hunter22");

    await render(dp);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Show Password"]')!.click(); });
    expect(val("password")).toBe("hunter22");
    // Back: the view unmounts (the window shows the list again), then the row is opened a second time.
    await act(async () => { root.render(choice); });
    expect(host.textContent).not.toContain("hunter22");
    await render(dp);
    expect(val("password")).toBe(MASK);
    expect(dp.read).toHaveBeenCalledTimes(2); // read fresh on each open, nothing kept in between
  });

  it("security: the session lock's hide-secrets event masks revealed values", async () => {
    const { VAULT_HIDE_SECRETS_EVENT } = await import("../hooks/useAutoHide");
    await render(deps(loginFile));
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Show Password"]')!.click(); });
    expect(val("password")).toBe("hunter22");
    await act(async () => { window.dispatchEvent(new Event(VAULT_HIDE_SECRETS_EVENT)); });
    expect(val("password")).toBe(MASK);
  });

  it("locked or unreadable: an intentional state, not a blank view", async () => {
    await render({ status: async () => ({ exists: true, unlocked: true }), read: async () => { throw new Error("gone"); } });
    expect(host.querySelector(".af-state--error")?.textContent).toContain("Couldn't read this entry");
  });
});
