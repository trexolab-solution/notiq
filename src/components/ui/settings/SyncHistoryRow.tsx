import { useState } from "react";
import { History } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { Button } from "../Button";
import { SYNC_INDEX } from "./syncIndex";
import { SyncHistoryDialog } from "./SyncHistoryDialog";

const META = SYNC_INDEX.find((x) => x.id === "vault.sync.history");

/** Settings → Sync: "Restore vault from a date…" (opens the restore-point dialog). */
export function RestoreFromDateRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingRow id="vault.sync.history" label="Restore vault from a date"
                  keywords={META ? [...(META.keywords ?? []), META.description ?? ""] : []}
                  description="Bring back notes from an earlier day, for example after something was deleted by mistake. They're merged into your vault; nothing is removed.">
        <Button className="settings-btn" size="sm" icon={<History size={12} />} aria-haspopup="dialog"
                onClick={() => setOpen(true)}>
          Restore from a date…
        </Button>
      </SettingRow>
      {open && <SyncHistoryDialog onClose={() => setOpen(false)} />}
    </>
  );
}
