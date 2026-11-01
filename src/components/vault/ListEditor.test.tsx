// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./HistoryDialog", () => ({ HistoryDialog: () => null }));
const toastInfo = vi.fn();
vi.mock("../../lib/toast", () => ({ toast: { info: (...a: unknown[]) => toastInfo(...a), dismiss: vi.fn() } }));

import { LoginSitesEditor } from "./LoginSitesEditor";
import { CustomFieldsEditor, fieldNameError } from "./CustomFieldsEditor";
import { moveItem, reinsert } from "./ListEditor";
import { emptyLogin, MAX_LOGIN_URLS, type LoginEntry } from "../../lib/loginEntry";
import { MAX_CUSTOM_FIELDS, type CustomField } from "../../lib/customFields";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  toastInfo.mockReset();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; vi.useRealTimers(); });

const btn = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const click = (el: HTMLElement) => act(() => { el.click(); });
const live = () => host.querySelector('[role="status"][aria-live="polite"]')!;
const flush = () => act(() => { vi.advanceTimersByTime(50); });

/** Types into a controlled React input. */
function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
const key = (el: HTMLElement, k: string) =>
  act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
/** A key while a menu is open: ContextMenu listens on window (capture), wherever focus is. */
const winKey = (k: string) => key(document.activeElement as HTMLElement ?? document.body, k);
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.trim() === label)!;
/** Opens a custom field's ⋯ menu and clicks one of its items. */
const pick = (field: string, item: string) => { click(btn(`More actions for ${field}`)!); click(menuItem(item)); };

function Sites({ initial }: { initial: string[] }) {
  const [entry, setEntry] = useState<LoginEntry>({ ...emptyLogin("Bank"), url: "https://bank.example", urls: initial });
  return <LoginSitesEditor entry={entry} onChange={(urls) => setEntry((e) => ({ ...e, urls }))} />;
}
function Fields({ initial }: { initial: CustomField[] }) {
  const [value, setValue] = useState(initial);
  return <CustomFieldsEditor value={value} onChange={setValue} />;
}
const renderSites = (urls: string[]) => act(() => { root.render(<Sites initial={urls} />); });
const renderFields = (f: CustomField[]) => act(() => { root.render(<Fields initial={f} />); });

describe("Other websites (LoginSitesEditor)", () => {
  it("is a semantic list whose row buttons name the site", () => {
    renderSites(["a.example", "b.example"]);
    expect(host.querySelectorAll("ul > li[data-list-row]")).toHaveLength(2);
    expect(btn("Remove website a.example")).toBeTruthy();
    expect(btn("Open b.example")).toBeTruthy();
  });

  it("Add website focuses the new input; Enter adds and announces it", () => {
    renderSites([]);
    click(byText("Add website"));
    const box = input("New website for this login");
    expect(document.activeElement).toBe(box);
    type(box, "c.example");
    key(box, "Enter");
    flush();
    expect(btn("Remove website c.example")).toBeTruthy();
    expect(live().textContent).toBe("Added c.example");
    // The box stays open and focused for the next site.
    expect(document.activeElement).toBe(input("New website for this login"));
  });

  it("shows validation inline, wired with aria-invalid and aria-describedby", () => {
    renderSites(["a.example"]);
    click(byText("Add website"));
    const box = input("New website for this login");
    expect(box.getAttribute("aria-invalid")).toBeNull();
    type(box, "not a site");
    key(box, "Enter");
    const err = input("New website for this login");
    expect(err.getAttribute("aria-invalid")).toBe("true");
    const id = err.getAttribute("aria-describedby")!;
    expect(document.getElementById(id)?.textContent).toMatch(/doesn't look/);
    // Editing clears it.
    type(err, "d.example");
    expect(input("New website for this login").getAttribute("aria-invalid")).toBeNull();
  });

  it("Escape cancels and returns focus to Add website", () => {
    renderSites([]);
    click(byText("Add website"));
    key(input("New website for this login"), "Escape");
    expect(document.activeElement).toBe(byText("Add website"));
  });

  it("removing focuses the next row, then the Add button when none is left, and offers Undo", () => {
    renderSites(["a.example", "b.example"]);
    click(btn("Remove website a.example")!);
    expect(document.activeElement).toBe(btn("Open b.example"));
    expect(toastInfo).toHaveBeenCalledWith("Removed a.example", expect.objectContaining({
      actions: [expect.objectContaining({ label: "Undo" })],
    }));
    click(btn("Remove website b.example")!);
    expect(document.activeElement).toBe(byText("Add website"));
    // Undo the first removal: it comes back at its old position.
    const undo = (toastInfo.mock.calls[0][1] as { actions: { onClick: () => void }[] }).actions[0];
    act(() => undo.onClick());
    expect(btn("Remove website a.example")).toBeTruthy();
  });

  it("at the limit the Add button is aria-disabled with an explanation, and does nothing", () => {
    renderSites(Array.from({ length: MAX_LOGIN_URLS }, (_, i) => `s${i}.example`));
    const add = byText("Add website");
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(add.getAttribute("aria-describedby")!)?.textContent).toBe(`Up to ${MAX_LOGIN_URLS} other websites`);
    click(add);
    expect(host.querySelector('input[aria-label="New website for this login"]')).toBeNull();
  });
});

describe("Custom fields (CustomFieldsEditor)", () => {
  const f = (label: string, value = "", secret = false): CustomField => ({ label, value, secret });

  it("Add field focuses the new row's name input", () => {
    renderFields([f("PIN", "1234")]);
    click(byText("Add field"));
    expect(document.activeElement).toBe(input("Field name 2"));
    flush();
    expect(live().textContent).toBe("Custom field 2 added");
  });

  it("Enter in the last value adds a row; Enter in a name jumps to its value", () => {
    renderFields([f("PIN", "1234")]);
    key(input("Field name 1"), "Enter");
    expect(document.activeElement).toBe(input("Value of PIN"));
    key(input("Value of PIN"), "Enter");
    expect(host.querySelectorAll("li[data-list-row]")).toHaveLength(2);
    expect(document.activeElement).toBe(input("Field name 2"));
  });

  it("row actions carry the field's name; a hidden field shows its badge and masks the value", () => {
    renderFields([f("Customer ID", "C-1", true)]);
    expect(btn("Copy value of Customer ID")).toBeTruthy();
    expect(btn("Show value of Customer ID")).toBeTruthy();
    expect(btn("More actions for Customer ID")!.getAttribute("aria-haspopup")).toBe("menu");
    expect(host.querySelector("li[data-list-row]")!.textContent).toContain("Hidden");
    expect(input("Value of Customer ID").type).toBe("password");
    click(btn("Show value of Customer ID")!);
    expect(input("Value of Customer ID").type).toBe("text");
  });

  it("every row has the same action slots, so value inputs line up", () => {
    renderFields([f("A", "1"), f("B", "2", true)]);
    const slots = [...host.querySelectorAll("li[data-list-row]")]
      .map((li) => li.querySelector("[data-field-value]")!.nextElementSibling!.children.length);
    expect(slots).toEqual([3, 3]);
  });

  it("remove moves focus to the next row, then to Add field; an empty row has no Undo", () => {
    renderFields([f("A", "1"), f(""), f("C", "3")]);
    pick("field 2", "Remove field");
    expect(document.activeElement).toBe(input("Field name 2"));
    expect(toastInfo).not.toHaveBeenCalled();
    pick("C", "Remove field");
    expect(document.activeElement).toBe(input("Field name 1"));
    expect(toastInfo).toHaveBeenCalledTimes(1);
    pick("A", "Remove field");
    expect(document.activeElement).toBe(byText("Add field"));
  });

  it("move up/down reorders and keeps focus on the moved row's menu button", () => {
    renderFields([f("A"), f("B")]);
    pick("B", "Move up");
    const names = [...host.querySelectorAll<HTMLInputElement>("input[data-row-focus]")].map((i) => i.value);
    expect(names).toEqual(["B", "A"]);
    expect(document.activeElement).toBe(btn("More actions for B"));
    flush();
    expect(live().textContent).toBe("B moved to position 1 of 2");
  });

  describe("⋯ menu", () => {
    it("opens from the keyboard on the first enabled item; Move up is disabled on the first row", () => {
      renderFields([f("A", "1"), f("B", "2")]);
      const more = btn("More actions for A")!;
      more.focus();
      key(more, "ArrowDown");
      expect(more.getAttribute("aria-expanded")).toBe("true");
      const menu = document.querySelector('[role="menu"]')!;
      expect(menu.getAttribute("aria-label")).toBe("Actions for A");
      expect(menuItem("Move up").disabled).toBe(true);
      expect(menuItem("Move up").getAttribute("aria-disabled")).toBe("true");
      expect(document.activeElement).toBe(menuItem("Move down"));
      // Arrows skip the disabled item and wrap.
      winKey("ArrowDown");
      expect(document.activeElement).toBe(menuItem("Hide value"));
      winKey("ArrowDown");
      expect(document.activeElement).toBe(menuItem("Remove field"));
      winKey("ArrowDown");
      expect(document.activeElement).toBe(menuItem("Move down"));
    });

    it("Escape closes it and returns focus to the button", () => {
      renderFields([f("A", "1")]);
      const more = btn("More actions for A")!;
      click(more);
      expect(document.querySelector('[role="menu"]')).toBeTruthy();
      winKey("Escape");
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(more.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(more);
    });

    it("Enter on Move down moves the row", () => {
      renderFields([f("A"), f("B")]);
      const more = btn("More actions for A")!;
      more.focus();
      key(more, "ArrowDown");
      winKey("Enter");
      const names = [...host.querySelectorAll<HTMLInputElement>("input[data-row-focus]")].map((i) => i.value);
      expect(names).toEqual(["B", "A"]);
      expect(document.activeElement).toBe(btn("More actions for A"));
    });

    it("Hide value / Show as text toggles the field's type", () => {
      renderFields([f("PIN", "1234")]);
      expect(input("Value of PIN").type).toBe("text");
      expect(btn("Show value of PIN")).toBeNull();
      pick("PIN", "Hide value");
      expect(input("Value of PIN").type).toBe("password");
      expect(btn("Show value of PIN")).toBeTruthy();
      expect(host.querySelector("li[data-list-row]")!.textContent).toContain("Hidden");
      flush();
      expect(live().textContent).toBe("PIN is now hidden");
      pick("PIN", "Show as text");
      expect(input("Value of PIN").type).toBe("text");
      expect(host.querySelector("li[data-list-row]")!.textContent).not.toContain("Hidden");
    });
  });

  it("at the limit Add field is aria-disabled with the reason", () => {
    renderFields(Array.from({ length: MAX_CUSTOM_FIELDS }, (_, i) => f(`F${i}`)));
    const add = byText("Add field");
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(add.getAttribute("aria-describedby")!)?.textContent).toBe(`Up to ${MAX_CUSTOM_FIELDS} custom fields`);
    click(add);
    expect(host.querySelectorAll("li[data-list-row]")).toHaveLength(MAX_CUSTOM_FIELDS);
  });

  it("duplicate names are flagged inline with aria-invalid / aria-describedby", () => {
    renderFields([f("PIN", "1"), f("pin", "2")]);
    const dup = input("Field name 2");
    expect(dup.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(dup.getAttribute("aria-describedby")!)?.textContent).toMatch(/already uses this name/);
    expect(input("Field name 1").getAttribute("aria-invalid")).toBeNull();
  });

  it("fieldNameError: a missing name only matters once there is a value", () => {
    expect(fieldNameError(f("", ""), 0, [])).toBeNull();
    expect(fieldNameError(f("", "x"), 0, [])).toMatch(/name/);
  });
});

describe("list helpers", () => {
  it("reinsert / moveItem", () => {
    expect(reinsert(["a", "c"], 1, "b")).toEqual(["a", "b", "c"]);
    expect(reinsert(["a"], 9, "b")).toEqual(["a", "b"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a"], 0, -1)).toEqual(["a"]);
  });
});
