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
import { moveTo, reinsert } from "./ListEditor";
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
function Fields({ initial, spy }: { initial: CustomField[]; spy?: (next: CustomField[]) => void }) {
  const [value, setValue] = useState(initial);
  return <CustomFieldsEditor value={value} onChange={(next) => { spy?.(next); setValue(next); }} />;
}
const renderSites = (urls: string[]) => act(() => { root.render(<Sites initial={urls} />); });
const renderFields = (f: CustomField[], spy?: (next: CustomField[]) => void) =>
  act(() => { root.render(<Fields initial={f} spy={spy} />); });

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

  describe("reordering", () => {
    const names = () => [...host.querySelectorAll<HTMLInputElement>("input[data-row-focus]")].map((i) => i.value);

    it("each row has a labelled drag handle with instructions; the menu has no Move items", () => {
      renderFields([f("A"), f("B")]);
      const handle = btn("Reorder A")!;
      expect(handle.hasAttribute("data-row-handle")).toBe(true);
      expect(document.getElementById(handle.getAttribute("aria-describedby")!.split(" ")[0])?.textContent).toMatch(/Space to pick up/);
      click(btn("More actions for A")!);
      expect(document.querySelector('[role="menu"]')!.textContent).not.toMatch(/Move/);
    });

    it("keyboard: Space picks up, arrows move, Enter drops — one change, focus stays on the handle", () => {
      const spy = vi.fn();
      renderFields([f("A"), f("B"), f("C")], spy);
      const h = btn("Reorder A")!;
      h.focus();
      key(h, " ");
      flush();
      expect(live().textContent).toBe("Picked up A, position 1 of 3");
      expect(btn("Reorder A")!.getAttribute("aria-pressed")).toBe("true");
      key(document.activeElement as HTMLElement, "ArrowDown");
      flush();
      expect(live().textContent).toBe("A, position 2 of 3");
      expect(document.activeElement).toBe(btn("Reorder A"));
      key(document.activeElement as HTMLElement, "ArrowDown");
      flush();
      expect(live().textContent).toBe("A, position 3 of 3");
      expect(names()).toEqual(["B", "C", "A"]); // previewed in place…
      expect(spy).not.toHaveBeenCalled();       // …but nothing written yet
      key(document.activeElement as HTMLElement, "Enter");
      flush();
      expect(live().textContent).toBe("Dropped A at position 3 of 3");
      expect(names()).toEqual(["B", "C", "A"]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(btn("Reorder A"));
      expect(btn("Reorder A")!.getAttribute("aria-pressed")).toBe("false");
    });

    it("keyboard: Escape cancels back to the original position", () => {
      const spy = vi.fn();
      renderFields([f("A"), f("B"), f("C")], spy);
      const h = btn("Reorder B")!;
      h.focus();
      key(h, "Enter");
      key(document.activeElement as HTMLElement, "ArrowUp");
      expect(names()).toEqual(["B", "A", "C"]);
      key(document.activeElement as HTMLElement, "Escape");
      flush();
      expect(names()).toEqual(["A", "B", "C"]);
      expect(live().textContent).toBe("Reorder cancelled. B is back at position 2 of 3");
      expect(spy).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(btn("Reorder B"));
    });

    it("pointer: dragging a handle down past the next rows reorders on release", () => {
      const spy = vi.fn();
      renderFields([f("A"), f("B"), f("C")], spy);
      // Rows 50px tall, 60px apart; everything inside a row shares its row's box.
      const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        const row = this.closest("li[data-list-row]");
        const i = row ? [...row.parentElement!.children].indexOf(row) : -1;
        const top = i < 0 ? 0 : i * 60;
        const height = i < 0 ? 0 : 50;
        return { top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON() {} } as DOMRect;
      });
      const ptr = (type: string, y: number, target: EventTarget) => act(() => {
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, button: 0, pointerId: 1, clientX: 10, clientY: y }));
        vi.advanceTimersByTime(20);
      });
      try {
        ptr("pointerdown", 25, btn("Reorder A")!);
        ptr("pointermove", 32, document); // past the 4px activation distance
        flush();
        expect(live().textContent).toBe("Picked up A, position 1 of 3");
        ptr("pointermove", 100, document);
        flush();
        expect(live().textContent).toBe("A, position 2 of 3");
        ptr("pointermove", 152, document); // A's centre is now over C's
        expect(spy).not.toHaveBeenCalled();
        ptr("pointerup", 152, document);
        flush();
      } finally {
        rect.mockRestore();
      }
      expect(names()).toEqual(["B", "C", "A"]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(live().textContent).toBe("Dropped A at position 3 of 3");
      expect(document.activeElement).toBe(btn("Reorder A"));
    });
  });

  describe("⋯ menu", () => {
    it("opens from the keyboard on its first item, with arrow navigation that wraps", () => {
      renderFields([f("A", "1"), f("B", "2")]);
      const more = btn("More actions for A")!;
      more.focus();
      key(more, "ArrowDown");
      expect(more.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector('[role="menu"]')!.getAttribute("aria-label")).toBe("Actions for A");
      expect(document.activeElement).toBe(menuItem("Hide value"));
      winKey("ArrowDown");
      expect(document.activeElement).toBe(menuItem("Remove field"));
      winKey("ArrowDown");
      expect(document.activeElement).toBe(menuItem("Hide value"));
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

    it("Enter on Remove field removes the row", () => {
      renderFields([f("A", "1"), f("B", "2")]);
      const more = btn("More actions for A")!;
      more.focus();
      key(more, "ArrowDown");
      winKey("ArrowDown");
      winKey("Enter");
      expect(host.querySelectorAll("li[data-list-row]")).toHaveLength(1);
      expect(document.activeElement).toBe(input("Field name 1"));
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
  it("reinsert", () => {
    expect(reinsert(["a", "c"], 1, "b")).toEqual(["a", "b", "c"]);
    expect(reinsert(["a"], 9, "b")).toEqual(["a", "b"]);
  });

  it("moveTo shifts the items in between, both ways", () => {
    expect(moveTo(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveTo(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveTo(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
  });

  it("moveTo leaves the list alone for no-op or out-of-range moves", () => {
    const list = ["a", "b"];
    expect(moveTo(list, 1, 1)).toBe(list);
    expect(moveTo(list, 0, -1)).toBe(list);
    expect(moveTo(list, 2, 0)).toBe(list);
    expect(moveTo(["x", "y", "z"], 0, 2)).not.toBe(list);
  });
});
