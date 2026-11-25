// @vitest-environment happy-dom
/** The sectioned entry form: one section shown at a time, all kept mounted, and a hidden field can be revealed. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { revealField, SectionedForm } from "./EntryParts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const q = (sel: string) => document.querySelector<HTMLElement>(sel);

beforeEach(async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <SectionedForm header={<h1>Entry</h1>} footer={<p id="foot">footer</p>}
        panels={[
          { id: "a", label: "First", content: <input id="in-a" /> },
          { id: "b", label: "Second", badge: 3, content: <input id="in-b" /> },
        ]} />,
    );
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const tab = (label: string) => [...document.querySelectorAll("nav button")].find((b) => b.textContent?.startsWith(label))!;

describe("SectionedForm", () => {
  it("shows the first section and keeps the others mounted but hidden", () => {
    expect(q("#in-a")!.closest("[hidden]")).toBeNull();
    expect(q("#in-b")!.closest("[hidden]")).not.toBeNull();
    expect(tab("First").getAttribute("aria-current")).toBe("page");
    expect(q("#foot")).toBeTruthy();
  });

  it("switches sections from the nav and shows the badge", async () => {
    expect(tab("Second").textContent).toContain("3");
    await act(async () => { (tab("Second") as HTMLElement).click(); });
    expect(q("#in-b")!.closest("[hidden]")).toBeNull();
    expect(q("#in-a")!.closest("[hidden]")).not.toBeNull();
  });

  it("revealField shows the section that holds a field", async () => {
    await act(async () => { revealField("in-b"); });
    expect(q("#in-b")!.closest("[hidden]")).toBeNull();
    expect(tab("Second").getAttribute("aria-current")).toBe("page");
  });
});
