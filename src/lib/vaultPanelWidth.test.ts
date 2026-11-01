import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VAULT_PANEL_DEFAULT, VAULT_PANEL_KEY, VAULT_PANEL_MAX, VAULT_PANEL_MIN,
  clampVaultPanelWidth, loadVaultPanelWidth, maxVaultPanelWidth, saveVaultPanelWidth,
} from "./vaultPanelWidth";

beforeEach(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  });
});

describe("vault panel width", () => {
  it("max is half the window, capped, and never below min", () => {
    expect(maxVaultPanelWidth(1600)).toBe(VAULT_PANEL_MAX);
    expect(maxVaultPanelWidth(900)).toBe(450);
    expect(maxVaultPanelWidth(300)).toBe(VAULT_PANEL_MIN);
    expect(maxVaultPanelWidth(NaN)).toBe(VAULT_PANEL_MIN);
  });
  it("clamps to [min, max]", () => {
    expect(clampVaultPanelWidth(10, 1600)).toBe(VAULT_PANEL_MIN);
    expect(clampVaultPanelWidth(9999, 1600)).toBe(VAULT_PANEL_MAX);
    expect(clampVaultPanelWidth(9999, 800)).toBe(400);
    expect(clampVaultPanelWidth(300.4, 1600)).toBe(300);
    expect(clampVaultPanelWidth(NaN, 1600)).toBe(VAULT_PANEL_DEFAULT);
  });
  it("loads the default when nothing / garbage is stored", () => {
    expect(loadVaultPanelWidth(1600)).toBe(VAULT_PANEL_DEFAULT);
    localStorage.setItem(VAULT_PANEL_KEY, "abc");
    expect(loadVaultPanelWidth(1600)).toBe(VAULT_PANEL_DEFAULT);
  });
  it("round-trips and clamps a stored value to the current window", () => {
    saveVaultPanelWidth(420);
    expect(loadVaultPanelWidth(1600)).toBe(420);
    expect(loadVaultPanelWidth(700)).toBe(350);
    localStorage.setItem(VAULT_PANEL_KEY, "5");
    expect(loadVaultPanelWidth(1600)).toBe(VAULT_PANEL_MIN);
  });
});
