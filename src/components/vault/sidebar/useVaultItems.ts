import { useCallback, useEffect, useRef, useState } from "react";
import { useVaultStore } from "../../../store/vaultStore";
import { ERR_LOCKED, vaultList, vaultListTrash, vaultErrorMessage, type VaultItem } from "../../../lib/vault";
import { ensureVaultDir, VAULT_DIR_EVENT } from "../../../lib/vaultDir";

export interface VaultItemsState {
  /** Vault root (storage folder) — prefix of every full virtual path. */
  root: string;
  items: VaultItem[];
  trash: VaultItem[];
  /** First load hasn't finished yet. */
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const FILE_SAVED_EVENT = "vault:file-saved";

/**
 * Loads the vault's entry list (names/tags/stars only) and the Recycle Bin.
 * Reloads on vault changes, saves, window focus and lock/unlock. While the
 * vault is locked nothing is listed.
 */
export function useVaultItems(): VaultItemsState {
  const unlocked = useVaultStore((s) => s.unlocked);
  const [root, setRoot] = useState("");
  const [items, setItems] = useState<VaultItem[]>([]);
  const [trash, setTrash] = useState<VaultItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Drop results of a slow request that finished after a newer one started.
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await ensureVaultDir();
      if (my !== seq.current) return;
      setRoot(r);
      if (!useVaultStore.getState().unlocked) {
        setItems([]); setTrash([]); setError(null);
        return;
      }
      const [list, bin] = await Promise.all([vaultList(), vaultListTrash().catch(() => [] as VaultItem[])]);
      if (my !== seq.current) return;
      setItems(list);
      setTrash(bin);
      setError(null);
    } catch (e) {
      if (my !== seq.current) return;
      if (String(e).includes(ERR_LOCKED)) {
        // Backend locked behind our back (auto-lock) — mirror it.
        useVaultStore.getState().setUnlocked(false);
        setItems([]); setTrash([]); setError(null);
      } else {
        setError(vaultErrorMessage(e) || "Can't read the vault");
      }
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload, unlocked]);

  useEffect(() => {
    // Coalesce bursts (e.g. a rename fires the change event and a save event).
    let t: ReturnType<typeof setTimeout> | null = null;
    const soon = () => { if (t) clearTimeout(t); t = setTimeout(() => void reload(), 60); };
    window.addEventListener(VAULT_DIR_EVENT, soon);
    window.addEventListener(FILE_SAVED_EVENT, soon);
    window.addEventListener("focus", soon);
    return () => {
      if (t) clearTimeout(t);
      window.removeEventListener(VAULT_DIR_EVENT, soon);
      window.removeEventListener(FILE_SAVED_EVENT, soon);
      window.removeEventListener("focus", soon);
    };
  }, [reload]);

  return { root, items, trash, loading, error, reload };
}
