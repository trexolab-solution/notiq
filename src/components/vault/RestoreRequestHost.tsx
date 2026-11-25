import { useEffect, useState } from "react";
import { RestoreBackupDialog } from "./RestoreBackupDialog";
import { ImportSharedDialog } from "./ImportSharedDialog";
import { onRestoreRequest, takePendingRestore } from "../../lib/restoreRequest";
import { vaultBackupInspect } from "../../lib/vaultBackup";

/**
 * Opens the right dialog for a `.nqb` file handed over by the OS (double-click / "Open with"): a backup goes to
 * the restore dialog, a "Share items" file to the import-shared dialog. Both kinds share one extension, so the
 * file's header decides. Mounted once in the app shell; the dialog starts on that file, already being checked.
 */
export function RestoreRequestHost() {
  const [open, setOpen] = useState<{ path: string; kind: "backup" | "share" } | null>(null);

  useEffect(() => {
    let alive = true;
    const route = (path: string) => {
      // An unreadable file goes to the restore dialog, which shows the reason.
      vaultBackupInspect(path)
        .then((h): "backup" | "share" => (h.ok && h.kind === "share" ? "share" : "backup"))
        .catch((): "backup" | "share" => "backup")
        .then((kind) => { if (alive) setOpen({ path, kind }); });
    };
    const early = takePendingRestore();
    if (early) route(early);
    const off = onRestoreRequest((p) => { takePendingRestore(); route(p); });
    return () => { alive = false; off(); };
  }, []);

  if (!open) return null;
  // `key` restarts the dialog when a second file is opened while one is showing.
  return open.kind === "share"
    ? <ImportSharedDialog key={open.path} initialPath={open.path} onClose={() => setOpen(null)} />
    : <RestoreBackupDialog key={open.path} initialPath={open.path} onClose={() => setOpen(null)} />;
}
