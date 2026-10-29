import { describe, expect, it } from "vitest";
import {
  createDialogStack, DIALOG_WIDTHS, dialogKeyAction, dialogWidth, initialFocusChoice, trapFocusTarget,
  type DialogKeyContext,
} from "./dialogLogic";

const ctx = (over: Partial<DialogKeyContext> = {}): DialogKeyContext => ({
  isTop: true, dismissable: true, hasPrimary: true, danger: false, ...over,
});

describe("dialogWidth", () => {
  it("maps the presets", () => {
    expect(DIALOG_WIDTHS).toEqual({ sm: 400, md: 480, lg: 640, xl: 760 });
    expect(dialogWidth("sm")).toBe(400);
    expect(dialogWidth("md")).toBe(480);
    expect(dialogWidth("lg")).toBe(640);
    expect(dialogWidth("xl")).toBe(760);
  });
  it("defaults to md and accepts positive px numbers", () => {
    expect(dialogWidth(undefined)).toBe(480);
    expect(dialogWidth("huge" as never)).toBe(480);
    expect(dialogWidth(520.4)).toBe(520);
    expect(dialogWidth(0)).toBe(480);
    expect(dialogWidth(Number.NaN)).toBe(480);
  });
});

describe("dialogKeyAction", () => {
  it("Escape cancels only when dismissable and on top", () => {
    expect(dialogKeyAction({ key: "Escape" }, ctx())).toBe("cancel");
    expect(dialogKeyAction({ key: "Escape" }, ctx({ dismissable: false }))).toBeNull();
    expect(dialogKeyAction({ key: "Escape" }, ctx({ isTop: false }))).toBeNull();
  });
  it("Escape never maps to the primary action, even for danger dialogs", () => {
    expect(dialogKeyAction({ key: "Escape" }, ctx({ danger: true }))).toBe("cancel");
  });
  it("Enter runs the primary action from a text field or the panel", () => {
    expect(dialogKeyAction({ key: "Enter", targetTag: "INPUT", targetType: "text" }, ctx())).toBe("primary");
    expect(dialogKeyAction({ key: "Enter", targetTag: "div" }, ctx())).toBe("primary");
    expect(dialogKeyAction({ key: "Enter" }, ctx())).toBe("primary");
  });
  it("Enter never fires the primary action of a danger dialog", () => {
    expect(dialogKeyAction({ key: "Enter", targetTag: "div" }, ctx({ danger: true }))).toBeNull();
  });
  it("Enter leaves native behaviour alone", () => {
    for (const targetTag of ["button", "A", "textarea", "select"]) {
      expect(dialogKeyAction({ key: "Enter", targetTag }, ctx())).toBeNull();
    }
    expect(dialogKeyAction({ key: "Enter", targetTag: "input", targetType: "checkbox" }, ctx())).toBeNull();
    expect(dialogKeyAction({ key: "Enter", targetTag: "input", targetInForm: true }, ctx())).toBeNull();
    expect(dialogKeyAction({ key: "Enter", targetTag: "div", targetEditable: true }, ctx())).toBeNull();
    expect(dialogKeyAction({ key: "Enter", targetTag: "input", isComposing: true }, ctx())).toBeNull();
    expect(dialogKeyAction({ key: "Enter", targetTag: "input", shiftKey: true }, ctx())).toBeNull();
    expect(dialogKeyAction({ key: "Enter", targetTag: "input", ctrlKey: true }, ctx())).toBeNull();
  });
  it("Enter does nothing without a primary handler or when not on top", () => {
    expect(dialogKeyAction({ key: "Enter" }, ctx({ hasPrimary: false }))).toBeNull();
    expect(dialogKeyAction({ key: "Enter" }, ctx({ isTop: false }))).toBeNull();
  });
  it("Tab is trapped; modified Tab and other keys are ignored", () => {
    expect(dialogKeyAction({ key: "Tab" }, ctx())).toBe("trap");
    expect(dialogKeyAction({ key: "Tab", shiftKey: true }, ctx())).toBe("trap");
    expect(dialogKeyAction({ key: "Tab", ctrlKey: true }, ctx())).toBeNull();
    expect(dialogKeyAction({ key: "Tab" }, ctx({ isTop: false }))).toBeNull();
    expect(dialogKeyAction({ key: "a" }, ctx())).toBeNull();
  });
});

describe("trapFocusTarget", () => {
  it("wraps forward from the last element and backward from the first", () => {
    expect(trapFocusTarget(3, 2, false)).toBe(0);
    expect(trapFocusTarget(3, 0, true)).toBe(2);
  });
  it("lets the browser move focus in the middle", () => {
    expect(trapFocusTarget(3, 0, false)).toBeNull();
    expect(trapFocusTarget(3, 1, true)).toBeNull();
  });
  it("pulls focus back in from outside", () => {
    expect(trapFocusTarget(3, -1, false)).toBe(0);
    expect(trapFocusTarget(3, -1, true)).toBe(2);
  });
  it("keeps focus on the panel when nothing is tabbable", () => {
    expect(trapFocusTarget(0, -1, false)).toBe(-1);
  });
  it("single element wraps onto itself", () => {
    expect(trapFocusTarget(1, 0, false)).toBe(0);
    expect(trapFocusTarget(1, 0, true)).toBe(0);
  });
});

describe("initialFocusChoice", () => {
  it("danger dialogs focus Cancel", () => {
    expect(initialFocusChoice(true)).toBe("cancel");
    expect(initialFocusChoice(true, "primary")).toBe("cancel");
  });
  it("others focus the primary action unless asked otherwise", () => {
    expect(initialFocusChoice(false)).toBe("primary");
    expect(initialFocusChoice(false, "cancel")).toBe("cancel");
  });
});

describe("createDialogStack", () => {
  it("the most recently allocated open dialog is on top, regardless of mount order", () => {
    const s = createDialogStack();
    const parent = s.nextId();
    const child = s.nextId();
    s.add(child); // React mounts the child's effects first
    s.add(parent);
    expect(s.top()).toBe(child);
    expect(s.isTop(child)).toBe(true);
    expect(s.isTop(parent)).toBe(false);
    s.remove(child);
    expect(s.isTop(parent)).toBe(true);
    s.remove(parent);
    expect(s.top()).toBeNull();
    expect(s.isTop(parent)).toBe(false);
  });
});
