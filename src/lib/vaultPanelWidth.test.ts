import { beforeEach, describe, expect, it, vi } from "vitest";
import { VAULT_PANEL_DEFAULT, VAULT_PANEL_KEY, VAULT_PANEL_MAX, VAULT_PANEL_MIN, vaultPanelWidth as w } from "./vaultPanelWidth";

beforeEach(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  });
});

const load = (windowWidth: number) => w.clamp(w.load(), windowWidth);

describe("vault panel width", () => {
  it("max is half the window, capped, and never below min", () => {
    expect(w.max(1600)).toBe(VAULT_PANEL_MAX);
    expect(w.max(900)).toBe(450);
    expect(w.max(300)).toBe(VAULT_PANEL_MIN);
    expect(w.max(NaN)).toBe(VAULT_PANEL_MIN);
  });
  it("clamps to [min, max]", () => {
    expect(w.clamp(10, 1600)).toBe(VAULT_PANEL_MIN);
    expect(w.clamp(9999, 1600)).toBe(VAULT_PANEL_MAX);
    expect(w.clamp(9999, 800)).toBe(400);
    expect(w.clamp(300.4, 1600)).toBe(300);
    expect(w.clamp(NaN, 1600)).toBe(VAULT_PANEL_DEFAULT);
  });
  it("loads the default when nothing / garbage is stored", () => {
    expect(load(1600)).toBe(VAULT_PANEL_DEFAULT);
    localStorage.setItem(VAULT_PANEL_KEY, "abc");
    expect(load(1600)).toBe(VAULT_PANEL_DEFAULT);
  });
  it("round-trips and clamps a stored value to the current window", () => {
    w.save(420);
    expect(load(1600)).toBe(420);
    expect(load(700)).toBe(350);
    localStorage.setItem(VAULT_PANEL_KEY, "5");
    expect(load(1600)).toBe(VAULT_PANEL_MIN);
  });
});
