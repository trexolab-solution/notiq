import React, { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Cloud, CloudAlert, CloudCheck, CloudOff, LockKeyhole, RefreshCw, type LucideIcon } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { syncIndicator, type SyncStatus } from "../../lib/vaultSync";
import {
  INDICATOR_TIP_EVENT, INDICATOR_TIP_TEXT, SYNC_BUTTON_SELECTOR, markIndicatorTipShown, readIndicatorTip, shouldShowIndicatorTip,
  surfaceIndicator, type SurfaceIndicator, type SurfaceKind,
} from "../../lib/syncSurfaces";
import { useSyncPopoverStore } from "./SyncPopover";
import { BusyIcon } from "../ui/Loading";

export const ICONS: Record<SurfaceKind, LucideIcon> = {
  synced: CloudCheck, syncing: RefreshCw, offline: CloudOff, problem: CloudAlert, locked: LockKeyhole, off: Cloud,
};

/** The button itself, for a known indicator (exported for tests). */
export function SyncIndicatorButton({ ind, onOpen, expanded }: {
  ind: SurfaceIndicator; onOpen: (anchor: HTMLElement) => void; expanded?: boolean;
}) {
  const Icon = ICONS[ind.kind];
  return (
    <Tooltip content={ind.tooltip} disabled={expanded}>
      <button
        type="button"
        className={`status-sync status-sync--${ind.kind}`}
        aria-label={ind.tooltip}
        aria-busy={ind.busy || undefined}
        aria-haspopup="dialog"
        aria-expanded={expanded ?? false}
        data-sync-state={ind.kind}
        data-tour="sync-indicator"
        onClick={(e) => onOpen(e.currentTarget)}
      >
        {/* Status bar has room: the sync arrows spin + "Syncing…" (ui/Loading.tsx rule 4). */}
        <BusyIcon icon={Icon} busy={ind.busy} spinSelf size={11} />
        <span>{ind.label}</span>
      </button>
    </Tooltip>
  );
}

/**
 * Status-bar Vault Sync indicator. With `vaultExists` it shows whenever there is a vault (a subtle "Sync off"
 * while sync is off); without it, only while sync is on. Click opens the sync popover.
 */
export const SyncIndicator = React.memo(function SyncIndicator({ status, onOpen, vaultExists, expanded }: {
  status: SyncStatus | null;
  onOpen: (anchor: HTMLElement) => void;
  vaultExists?: boolean;
  expanded?: boolean;
}) {
  const ind = vaultExists ? surfaceIndicator(status, true) : syncIndicator(status);
  if (!ind) return null;
  // The one-time tip points at the title bar cloud button (SyncTitlebarButton), not here.
  return <SyncIndicatorButton ind={ind} onOpen={onOpen} expanded={expanded} />;
});

// ── One-time tip bubble ─────────────────────────────────────────────────────────

/** Re-reads the tip flag when it may have changed (another window, focus, or the same-window nudge). */
function useTipFlag(): [string | null, () => void] {
  const [flag, setFlag] = useState<string | null>(() => readIndicatorTip());
  useEffect(() => {
    // Only ever picks up a new "pending"; once displayed the bubble stays until dismissed (the stored flag
    // already says "shown" by then).
    const reread = () => { if (readIndicatorTip() === "pending") setFlag("pending"); };
    window.addEventListener("storage", reread);
    window.addEventListener("focus", reread);
    window.addEventListener(INDICATOR_TIP_EVENT, reread);
    return () => {
      window.removeEventListener("storage", reread);
      window.removeEventListener("focus", reread);
      window.removeEventListener(INDICATOR_TIP_EVENT, reread);
    };
  }, []);
  const dismiss = useCallback(() => { markIndicatorTipShown(); setFlag("shown"); }, []);
  return [flag, dismiss];
}

/**
 * Shown once while `notiq.sync.indicatorTip` is "pending", next to the element `selector` finds (mounted
 * only with that element): `below` it (title bar button, the default) or `above` it (status bar).
 */
export function IndicatorTip({ selector = SYNC_BUTTON_SELECTOR, placement = "below" }: {
  selector?: string; placement?: "above" | "below";
} = {}) {
  const [flag, dismiss] = useTipFlag();
  const show = shouldShowIndicatorTip(flag, true);
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number } | null>(null);

  // Mark it seen as soon as it's displayed; it stays up for this session until dismissed.
  useEffect(() => { if (show) markIndicatorTipShown(); }, [show]);

  useLayoutEffect(() => {
    if (!show) return;
    const place = () => {
      const el = document.querySelector(selector);
      if (!el) { setPos(null); return; }
      const r = el.getBoundingClientRect();
      const right = Math.max(8, window.innerWidth - r.right - 8);
      setPos(placement === "below" ? { right, top: r.bottom + 8 } : { right, bottom: window.innerHeight - r.top + 8 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [show, selector, placement]);

  // Opening the popover answers the tip.
  const popoverOpen = useSyncPopoverStore((s) => s.open);
  useEffect(() => { if (show && popoverOpen) dismiss(); }, [show, popoverOpen, dismiss]);

  if (!show || !pos) return null;
  return createPortal(
    <div className={`sync-tip${placement === "below" ? " sync-tip--below" : ""}`} role="status"
         style={{ right: pos.right, top: pos.top, bottom: pos.bottom }}>
      <span>{INDICATOR_TIP_TEXT}</span>
      <button type="button" className="sync-tip__btn" onClick={dismiss}>Got it</button>
    </div>,
    document.body,
  );
}
