import { useEffect, useState } from "react";
import { useVaultStore } from "../../store/vaultStore";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { vaultImportLegacy, vaultLegacyCleanup, vaultLegacyCount, vaultErrorMessage } from "../../lib/vault";
import { VAULT_DIR_EVENT } from "../../lib/vaultDir";
import { toast } from "../../lib/toast";

/**
 * After the vault unlocks: moves old per-note `.nqv` files into the single
 * encrypted vault file, then asks before deleting the originals.
 */
export function LegacyVaultImport() {
  const [moved, setMoved] = useState(0);

  useEffect(() => {
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        if ((await vaultLegacyCount()) <= 0) return;
        const n = await vaultImportLegacy();
        if (n <= 0) return;
        toast.success(`Moved ${n} note${n === 1 ? "" : "s"} into your encrypted vault file`);
        window.dispatchEvent(new Event(VAULT_DIR_EVENT));
        setMoved(n);
      } catch (e) {
        console.warn("vault: legacy import failed", e);
        toast.error(vaultErrorMessage(e));
      } finally {
        busy = false;
      }
    };
    if (useVaultStore.getState().unlocked) void run();
    return useVaultStore.subscribe((s, prev) => { if (s.unlocked && !prev.unlocked) void run(); });
  }, []);

  if (!moved) return null;
  return (
    <ConfirmDialog
      title="Delete the old note files?"
      message={`${moved} locked note${moved === 1 ? " was" : "s were"} copied into your single encrypted vault file. The old per-note .nqv files are still on disk. Delete them now? Make sure your vault has backed up first if you rely on it.`}
      icon="file"
      confirmLabel="Delete old files"
      cancelLabel="Keep them"
      danger
      onConfirm={async () => {
        setMoved(0);
        try {
          const n = await vaultLegacyCleanup();
          toast.info(`Deleted ${n} old file${n === 1 ? "" : "s"}`);
        } catch (e) {
          toast.error(vaultErrorMessage(e));
        }
      }}
      onCancel={() => setMoved(0)}
    />
  );
}
