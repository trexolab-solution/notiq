import { useEffect, useState } from "react";
import { RestoreBackupDialog } from "./RestoreBackupDialog";
import { onRestoreRequest, takePendingRestore } from "../../lib/restoreRequest";

/**
 * Opens the restore dialog on a backup file handed over by the OS (double-click / "Open with").
 * Mounted once in the app shell; the dialog starts on that file, already being checked.
 */
export function RestoreRequestHost() {
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    const early = takePendingRestore();
    if (early) setPath(early);
    return onRestoreRequest((p) => { takePendingRestore(); setPath(p); });
  }, []);

  if (!path) return null;
  // `key` restarts the dialog when a second backup is opened while it is showing.
  return <RestoreBackupDialog key={path} initialPath={path} onClose={() => setPath(null)} />;
}
