import { Cloud, CloudAlert, CloudCheck, CloudOff, LockKeyhole, RefreshCw, type LucideIcon } from "lucide-react";
import { Tooltip } from "../../ui/Tooltip";
import { useVaultStore } from "../../../store/vaultStore";
import { useSyncStatus, type SyncStatus } from "../../../lib/vaultSync";
import { badgeTooltip, surfaceIndicator, type SurfaceKind } from "../../../lib/syncSurfaces";
import { useSyncPopoverStore } from "../../layout/SyncPopover";
import { BusyIcon } from "../../ui/Loading";

const ICONS: Record<SurfaceKind, LucideIcon> = {
  synced: CloudCheck, syncing: RefreshCw, offline: CloudOff, problem: CloudAlert, locked: LockKeyhole, off: Cloud,
};

/** The badge for a known status (exported for tests); null when hidden. */
export function SyncBadgeButton({ status, vaultExists, expanded, onOpen }: {
  status: SyncStatus | null; vaultExists: boolean; expanded: boolean; onOpen: (anchor: HTMLElement) => void;
}) {
  const ind = surfaceIndicator(status, vaultExists);
  const tip = badgeTooltip(status, vaultExists);
  if (!ind || !tip) return null;
  const Icon = ICONS[ind.kind];
  return (
    <Tooltip content={tip} disabled={expanded}>
      <button
        type="button"
        className={`vt-icon-btn vt-sync-badge vt-sync-badge--${ind.kind}`}
        aria-label={`Vault sync: ${tip}`}
        aria-busy={ind.busy || undefined}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        data-sync-state={ind.kind}
        onClick={(e) => onOpen(e.currentTarget)}
      >
        <BusyIcon icon={Icon} busy={ind.busy} spinSelf size={13} />
      </button>
    </Tooltip>
  );
}

/** Small cloud in the vault sidebar header; opens the same sync popover, anchored here. */
export function SyncBadge() {
  const status = useSyncStatus();
  const vaultExists = useVaultStore((s) => s.exists);
  const toggle = useSyncPopoverStore((s) => s.toggle);
  const expanded = useSyncPopoverStore((s) => s.open && !!s.anchor?.classList.contains("vt-sync-badge"));
  return <SyncBadgeButton status={status} vaultExists={vaultExists} expanded={expanded} onOpen={toggle} />;
}
