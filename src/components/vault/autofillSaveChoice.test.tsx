// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SaveFields } from "./autofillBodies";
import { planSave, setSaveAsNew, type LoginMatch, type SavePlan, type SaveRequest } from "../../lib/autofill";
import { emptyLogin } from "../../lib/loginEntry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

const m = (rel: string, title: string, updated: number): LoginMatch =>
  ({ path: `/v/${rel}`, rel, updated, entry: { ...emptyLogin(title), url: "https://bank.example", username: "me", password: "old" } });
const req: SaveRequest = { id: "s1", host: "bank.example", url: "https://bank.example/login", username: "me", password: "new", title: "Bank" };

async function render(plan: SavePlan, extra: Partial<Parameters<typeof SaveFields>[0]> = {}) {
  await act(async () => {
    root.render(<SaveFields req={req} plan={plan} name="Bank" onName={() => {}} nameError={null} reveal={false}
                            onReveal={() => {}} onEnter={() => {}} {...extra} />);
  });
}

describe("save prompt: choosing which login to update", () => {
  const personal = m("Logins/personal.nqv", "Personal bank", 100);
  const joint = m("Logins/joint.nqv", "Joint account", 300);

  it("several candidates: shows Update: <most recent> and lets the user pick another", async () => {
    const plan = planSave([personal, joint], { username: "me", password: "new" }, () => 0);
    const onTarget = vi.fn();
    await render(plan, { onTarget });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Login to update"]')!;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain("Joint account");
    expect(host.textContent).toContain("Updates the password of “Joint account”");
    await act(async () => { trigger.click(); });
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual(["Joint account", "Personal bank"]);
    await act(async () => { options[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onTarget).toHaveBeenCalledWith(1);
  });

  it("one candidate: no picker (unchanged behaviour)", async () => {
    await render(planSave([personal], { username: "me", password: "new" }));
    expect(host.querySelector('button[aria-label="Login to update"]')).toBeNull();
    expect(host.textContent).toContain("Updates the password of “Personal bank”");
  });

  it("Save as new: name field plus a way back to updating", async () => {
    const plan = setSaveAsNew(planSave([personal, joint], { username: "me", password: "new" }, () => 0), true);
    const onSaveAsNew = vi.fn();
    await render(plan, { onSaveAsNew });
    expect(host.querySelector("#af-save-name")).toBeTruthy();
    expect(host.querySelector('button[aria-label="Login to update"]')).toBeNull();
    const back = [...host.querySelectorAll("button")].find((b) => b.textContent === "Update an existing login instead")!;
    await act(async () => { back.click(); });
    expect(onSaveAsNew).toHaveBeenCalledWith(false);
  });

  it("the picker is disabled while saving", async () => {
    await render(planSave([personal, joint], { username: "me", password: "new" }, () => 0), { disabled: true });
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Login to update"]')!.disabled).toBe(true);
  });
});
