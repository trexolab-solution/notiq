import React from "react";
import { Cloud } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { useSyncStatus, type SyncStatus } from "../../lib/vaultSync";
import { titlebarIndicator, type SurfaceIndicator } from "../../lib/syncSurfaces";
import { ICONS, IndicatorTip } from "./SyncIndicator";
import { useSyncPopoverStore } from "./SyncPopover";

/** The button for a known indicator (exported for tests). */
export function SyncTitlebarButtonView({ ind, expanded, onOpen }: {
  ind: SurfaceIndicator; expanded: boolean; onOpen: (anchor: HTMLElement) => void;
}) {
  // Problem: the cloud with a red dot; the other states use the status bar's icons.
  const Icon = ind.kind === "problem" ? Cloud : ICONS[ind.kind];
  const label = `Vault sync: ${ind.label}`;
  const detail = ind.tooltip.replace(/^Vault sync:\s*/i, "");
  const ariaLabel = `${label}. ${detail.charAt(0).toUpperCase()}${detail.slice(1)}`;
  return (
    <Tooltip content={ind.tooltip} disabled={expanded}>
      <button
        type="button"
        className={`titlebar-tool-btn titlebar-sync titlebar-sync--${ind.kind}`}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        data-sync-state={ind.kind}
        data-tour="sync-button"
        onClick={(e) => onOpen(e.currentTarget)}
      >
        <Icon size={15} strokeWidth={1.7} aria-hidden />
        {ind.kind === "problem" && <span className="titlebar-sync__dot" aria-hidden />}
      </button>
    </Tooltip>
  );
}

/** Pure part of the title bar button (exported for tests): null when this build can't sync. */
export function SyncTitlebarButtonFor({ status, expanded, onOpen }: {
  status: SyncStatus | null; expanded: boolean; onOpen: (anchor: HTMLElement) => void;
}) {
  const ind = titlebarIndicator(status);
  if (!ind) return null;
  return (
    <>
      <SyncTitlebarButtonView ind={ind} expanded={expanded} onOpen={onOpen} />
      <IndicatorTip />
    </>
  );
}

/**
 * Title bar cloud button (right icon group): sync state at a glance, opens the ONE sync popover anchored
 * here. Shown whenever this build can sync, also before a vault exists (new users find sync here).
 */
export const SyncTitlebarButton = React.memo(function SyncTitlebarButton() {
  const status = useSyncStatus();
  const toggle = useSyncPopoverStore((s) => s.toggle);
  const expanded = useSyncPopoverStore((s) => s.open && !!s.anchor?.classList.contains("titlebar-sync"));
  return <SyncTitlebarButtonFor status={status} expanded={expanded} onOpen={toggle} />;
});
