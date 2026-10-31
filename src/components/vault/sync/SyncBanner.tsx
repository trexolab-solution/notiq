import { useEffect, useState } from "react";
import { Cloud, X } from "lucide-react";
import { Tooltip } from "../../ui/Tooltip";
import { useVaultStore } from "../../../store/vaultStore";
import { useSyncStatus } from "../../../lib/vaultSync";
import { isSyncBannerDone, markSyncBannerDone, openSyncPopover, shouldShowSyncBanner } from "../../../lib/syncLifecycle";

/** Banner actions (exported for tests): both retire the banner for good. */
export const syncBannerActions = {
  open(): void { markSyncBannerDone(); openSyncPopover(); },
  dismiss(): void { markSyncBannerDone(); },
};

/** The banner itself (no hooks). */
export function SyncBannerView({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <div
      role="status" data-testid="sync-banner"
      className="mx-2 my-1.5 p-2 rounded-md text-xs border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text)]"
    >
      <div className="flex items-start gap-2">
        <Cloud size={13} className="shrink-0 mt-px text-[var(--color-primary)]" aria-hidden />
        <span className="flex-1"><b>New:</b> sync your vault across PCs through your own Google Drive.</span>
        <Tooltip content="Dismiss">
          <button
            type="button" aria-label="Dismiss"
            className="shrink-0 cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            onClick={onDismiss}
          >
            <X size={12} />
          </button>
        </Tooltip>
      </div>
      <button
        type="button"
        className="mt-1.5 ml-5 font-semibold cursor-pointer text-[var(--color-primary)] hover:underline"
        onClick={onOpen}
      >
        Set up sync
      </button>
    </div>
  );
}

/**
 * Vault panel, once for existing vaults with sync off: "New: sync your vault across PCs". Its action opens the
 * status-bar sync popover (`notiq:open-sync-popover`). Gated by standalone localStorage, so it never returns.
 */
export function SyncBanner() {
  const exists = useVaultStore((s) => s.exists);
  const status = useSyncStatus();
  const [done, setDone] = useState(isSyncBannerDone);
  // Sync turned on anywhere (popover, Settings): the banner has done its job.
  const enabled = !!status?.enabled;
  useEffect(() => { if (enabled) markSyncBannerDone(); }, [enabled]);
  if (!shouldShowSyncBanner({ exists, status, done })) return null;
  return (
    <SyncBannerView
      onOpen={() => { setDone(true); syncBannerActions.open(); }}
      onDismiss={() => { setDone(true); syncBannerActions.dismiss(); }}
    />
  );
}
