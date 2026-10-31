import React from "react";
import { CloudAlert, CloudCheck, CloudOff, LockKeyhole, RefreshCw, type LucideIcon } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { syncIndicator, type SyncIndicator as Indicator, type SyncIndicatorKind, type SyncStatus } from "../../lib/vaultSync";

const ICONS: Record<SyncIndicatorKind, LucideIcon> = {
  synced: CloudCheck, syncing: RefreshCw, offline: CloudOff, problem: CloudAlert, locked: LockKeyhole,
};

/** The button itself, for a known indicator (exported for tests). */
export function SyncIndicatorButton({ ind, onOpen }: { ind: Indicator; onOpen: () => void }) {
  const Icon = ICONS[ind.kind];
  return (
    <Tooltip content={ind.tooltip}>
      <button
        type="button"
        className={`status-sync status-sync--${ind.kind}`}
        aria-label={ind.tooltip}
        data-sync-state={ind.kind}
        onClick={onOpen}
      >
        <Icon size={11} aria-hidden />
        <span>{ind.label}</span>
      </button>
    </Tooltip>
  );
}

/** Status-bar Vault Sync indicator; renders nothing while sync is off. Click opens Settings → Vault → Sync. */
export const SyncIndicator = React.memo(function SyncIndicator({ status, onOpen }: {
  status: SyncStatus | null; onOpen: () => void;
}) {
  const ind = syncIndicator(status);
  return ind ? <SyncIndicatorButton ind={ind} onOpen={onOpen} /> : null;
});
