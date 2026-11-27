import { describe, expect, it, vi, beforeEach } from "vitest";

const status = vi.fn();
vi.mock("../lib/vault", () => ({ vaultStatus: () => status(), VAULT_CHANGED_EVENT: "vault:changed" }));
vi.mock("../lib/vaultDir", () => ({ ensureVaultDir: async () => "C:/vault" }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const clearAllCodeDrafts = vi.fn();
const endAllEntryEditing = vi.fn();
vi.mock("../lib/codeDrafts", () => ({ clearAllCodeDrafts: () => clearAllCodeDrafts() }));
vi.mock("../lib/entryUi", () => ({ endAllEntryEditing: () => endAllEntryEditing() }));

const { useVaultStore } = await import("./vaultStore");

beforeEach(() => {
  status.mockReset();
  clearAllCodeDrafts.mockReset();
  endAllEntryEditing.mockReset();
  useVaultStore.setState({ unlocked: true, exists: true, dialog: null });
});

describe("a lock found by asking the backend", () => {
  it("drops unsaved secrets, e.g. after Disconnect and remove vault", async () => {
    status.mockResolvedValue({ exists: false, unlocked: false });
    await useVaultStore.getState().refresh();
    expect(clearAllCodeDrafts).toHaveBeenCalled();
    expect(endAllEntryEditing).toHaveBeenCalled();
  });

  it("changes nothing while the vault stays open", async () => {
    status.mockResolvedValue({ exists: true, unlocked: true });
    await useVaultStore.getState().refresh();
    expect(clearAllCodeDrafts).not.toHaveBeenCalled();
  });

  it("keeps what is waiting to be saved while the user unlocks, and drops it if they don't", async () => {
    status.mockResolvedValue({ exists: true, unlocked: false });
    const ok = useVaultStore.getState().ensureUnlocked();
    await vi.waitFor(() => expect(useVaultStore.getState().dialog).toBe("unlock"));
    expect(clearAllCodeDrafts).not.toHaveBeenCalled();
    useVaultStore.getState().finish(true);
    expect(await ok).toBe(true);
    expect(clearAllCodeDrafts).not.toHaveBeenCalled();

    useVaultStore.setState({ unlocked: true });
    const no = useVaultStore.getState().ensureUnlocked();
    await vi.waitFor(() => expect(useVaultStore.getState().dialog).toBe("unlock"));
    useVaultStore.getState().finish(false);
    expect(await no).toBe(false);
    expect(clearAllCodeDrafts).toHaveBeenCalled();
  });
});
