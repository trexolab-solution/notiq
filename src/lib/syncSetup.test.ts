import { describe, expect, it } from "vitest";
import {
  decideAfterSignIn, itemsText, lastChangedText, mergedMessage, sourceDeviceName, twoVaultsDoneMessage, uploadQuestion,
  vaultReadyMessage, type LocalVaultFacts,
} from "./syncSetup";
import type { SyncDevice } from "./vaultSync";

const none: LocalVaultFacts = { exists: false, unlocked: false, items: null };
const local = (items: number | null, unlocked = true): LocalVaultFacts => ({ exists: true, unlocked, items });
const driveHas = { exists: true, sameVault: null };
const driveEmpty = { exists: false, sameVault: null };
const driveSame = { exists: true, sameVault: true };
const driveOther = { exists: true, sameVault: false };

describe("the decision after sign-in (design/vault-sync-ux-flow.md)", () => {
  it("row 1: no local vault + Drive has a vault → open the Drive vault (password only)", () => {
    expect(decideAfterSignIn(none, driveHas)).toEqual({ kind: "openDrive", replaceLocal: false });
  });

  it("row 2: no local vault + empty Drive → create the vault", () => {
    expect(decideAfterSignIn(none, driveEmpty)).toEqual({ kind: "create" });
  });

  it("row 3: an EMPTY local vault + a Drive vault → open the Drive vault directly (local replaced, backup kept)", () => {
    expect(decideAfterSignIn(local(0), driveOther)).toEqual({ kind: "openDrive", replaceLocal: true });
  });

  it("row 4: local vault + empty Drive → upload, with the item count", () => {
    expect(decideAfterSignIn(local(12), driveEmpty)).toEqual({ kind: "upload", items: 12 });
    expect(decideAfterSignIn(local(0), driveEmpty)).toEqual({ kind: "upload", items: 0 });
  });

  it("row 5: Drive holds the same vault → merge without asking (even an empty local vault)", () => {
    expect(decideAfterSignIn(local(12), driveSame)).toEqual({ kind: "merge" });
    expect(decideAfterSignIn(local(0), driveSame)).toEqual({ kind: "merge" });
  });

  it("row 6: local vault with items + a different Drive vault → the two-vaults dialog", () => {
    expect(decideAfterSignIn(local(12), driveOther)).toEqual({ kind: "twoVaults", items: 12 });
  });

  it("an unreadable item count is treated as 'has items' (never replaces a vault by guess)", () => {
    expect(decideAfterSignIn(local(null), driveOther)).toEqual({ kind: "twoVaults", items: null });
  });

  it("a locked local vault is unlocked first for rows 3–6, whatever Drive holds", () => {
    for (const remote of [driveEmpty, driveSame, driveOther]) {
      expect(decideAfterSignIn(local(null, false), remote)).toEqual({ kind: "unlock" });
    }
  });
});

const dev = (o: Partial<SyncDevice>): SyncDevice => ({ id: "d", name: "d", lastSeenMs: null, thisDevice: false, ...o });
const NOW = 1_000_000_000;

describe("Drive vault facts without the key", () => {
  it("names the other device seen most recently, with how long ago", () => {
    const devices = [
      dev({ id: "me", name: "DESK", lastSeenMs: NOW, thisDevice: true }),
      dev({ id: "a", name: "OFFICE", lastSeenMs: NOW - 5 * 3600_000 }),
      dev({ id: "b", name: "LAPTOP", lastSeenMs: NOW - 2 * 3600_000 }),
    ];
    expect(lastChangedText(devices, NOW)).toBe("last changed on LAPTOP, 2 hours ago");
    expect(sourceDeviceName(devices)).toBe("LAPTOP");
  });

  it("leaves out a name that is only the raw device id", () => {
    const devices = [dev({ id: "3f2a", name: "3f2a", lastSeenMs: NOW - 60_000 * 10 })];
    expect(lastChangedText(devices, NOW)).toBe("last changed 10 minutes ago");
    expect(sourceDeviceName(devices)).toBeNull();
  });

  it("is null when nothing is known", () => {
    expect(lastChangedText(null, NOW)).toBeNull();
    expect(lastChangedText([dev({ thisDevice: true, lastSeenMs: NOW })], NOW)).toBeNull();
    expect(sourceDeviceName([])).toBeNull();
  });
});

describe("copy", () => {
  it("uses numbers and names", () => {
    expect(itemsText(1)).toBe("1 item");
    expect(uploadQuestion(12)).toBe("Upload this vault (12 items) to Google Drive?");
    expect(uploadQuestion(null)).toBe("Upload this vault to Google Drive?");
    expect(vaultReadyMessage("LAPTOP")).toBe("Vault ready · synced with LAPTOP");
    expect(vaultReadyMessage(null)).toBe("Vault ready · synced with Google Drive");
    expect(mergedMessage({ added: 1, updated: 2, removed: 0, conflicts: [] })).toBe("Synced · 3 changes");
    expect(mergedMessage({ added: 0, updated: 0, removed: 0, conflicts: [] })).toBe("Synced · up to date");
    expect(twoVaultsDoneMessage("import", 12)).toBe("Vault ready · 12 items added");
    expect(twoVaultsDoneMessage("backupOnly", 0)).toBe("Vault ready · using the Google Drive vault");
  });
});
