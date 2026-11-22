import { describe, it, expect, vi, beforeEach } from "vitest";

const info = vi.fn();
vi.mock("../../lib/toast", () => ({ toast: { info: (...a: unknown[]) => info(...a) } }));

import { maybeShowTrayNotice } from "./trayNotice";

describe("maybeShowTrayNotice", () => {
  beforeEach(() => {
    info.mockClear();
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    });
  });

  it("shows once, then never again", () => {
    expect(maybeShowTrayNotice()).toBe(true);
    expect(maybeShowTrayNotice()).toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("does not show when the flag is already set", () => {
    localStorage.setItem("notiq:trayNoticeShown", "1");
    expect(maybeShowTrayNotice()).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });
});
