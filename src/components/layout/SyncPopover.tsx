import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Cloud, RefreshCw, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { useClickOutside } from "../../hooks/useClickOutside";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { computePopoverPos, type PopoverPos } from "../../lib/popoverPosition";
import { toast } from "../../lib/toast";
import { useAppStore } from "../../store";
import { useVaultStore } from "../../store/vaultStore";
import { useDeletionGuardUi } from "../../lib/syncDeletionGuard";
import { describeSyncResult, syncDevices, syncErrorMessage, syncNow, useSyncStatus, useSyncStore } from "../../lib/vaultSync";
import { reviewActions } from "../../lib/syncMarkers";
import {
  ACTION_LABELS, DRIVE_STORAGE_URL, OPEN_SYNC_POPOVER_EVENT, SYNC_BUTTON_SELECTOR, deviceCountLabel, isCacheFresh,
  markIndicatorTipShown, loadingModel, popoverModel, requestSyncSetup, syncSettingsRow,
  type BadgeTone, type PopoverAction, type PopoverModel, type SyncPopoverRequest,
} from "../../lib/syncSurfaces";
import { useSyncConnect, WAITING_FOR_GOOGLE } from "../vault/sync/useSyncConnect";
import { BusyIcon, Spinner, useLoadingWidth } from "../ui/Loading";

/** Status-bar indicator selector (the fallback anchor when the title bar button isn't on screen). */
export const SYNC_INDICATOR_SELECTOR = '[data-tour="sync-indicator"]';

/** Default anchor: the title bar cloud button, else the status-bar indicator. */
const defaultAnchor = () =>
  (document.querySelector(SYNC_BUTTON_SELECTOR) ?? document.querySelector(SYNC_INDICATOR_SELECTOR)) as HTMLElement | null;

// ── Open / close (one popover for the whole window) ────────────────────────────

interface PopoverState {
  open: boolean;
  anchor: HTMLElement | null;
  /** Action to start once open (palette "Connect Google Drive"). */
  intent: "connect" | null;
  show: (req?: SyncPopoverRequest) => void;
  /** Open anchored to `anchor`, or close when it's already open there (trigger buttons). */
  toggle: (anchor: HTMLElement) => void;
  close: () => void;
  clearIntent: () => void;
}

export const useSyncPopoverStore = create<PopoverState>((set, get) => ({
  open: false,
  anchor: null,
  intent: null,
  show(req) {
    const anchor = req?.anchor ?? defaultAnchor();
    set({ open: true, anchor, intent: req?.action ?? null });
  },
  toggle(anchor) {
    const s = get();
    if (s.open && s.anchor === anchor) set({ open: false });
    else set({ open: true, anchor, intent: null });
  },
  close() { set({ open: false }); },
  clearIntent() { set({ intent: null }); },
}));

/** Opens the sync popover from anywhere (same as dispatching `notiq:open-sync-popover`). */
export function openSyncPopover(req?: SyncPopoverRequest): void {
  window.dispatchEvent(new CustomEvent<SyncPopoverRequest | undefined>(OPEN_SYNC_POPOVER_EVENT, { detail: req }));
}

/** "Sync now" with the same result toasts as Settings → Vault → Sync (popover and palette). */
export async function runSyncNow(): Promise<void> {
  try {
    const r = await syncNow();
    toast.info(describeSyncResult(r) ?? "Your vault is up to date.", { source: "Vault sync", actions: reviewActions(r) });
  } catch (e) {
    toast.error("Sync failed", { source: "Vault sync", detail: syncErrorMessage(e) });
  } finally {
    void useSyncStore.getState().refresh();
  }
}

// ── Device count (fetched lazily, cached briefly) ──────────────────────────────

let deviceCache: { at: number; count: number } | null = null;
/** Test hook. */
export function resetDeviceCache() { deviceCache = null; }

function useDeviceCount(enabled: boolean): number | null {
  const [count, setCount] = useState<number | null>(() =>
    enabled && deviceCache && isCacheFresh(deviceCache.at, Date.now()) ? deviceCache.count : null);
  useEffect(() => {
    if (!enabled) return;
    if (deviceCache && isCacheFresh(deviceCache.at, Date.now())) { setCount(deviceCache.count); return; }
    let live = true;
    syncDevices()
      .then((list) => {
        deviceCache = { at: Date.now(), count: list.length };
        if (live) setCount(list.length);
      })
      .catch((e) => console.warn("vault sync: devices unavailable", e));
    return () => { live = false; };
  }, [enabled]);
  return enabled ? count : null;
}

// ── Panel (presentation, focus and dismissal) ──────────────────────────────────

const TONE_CLASS: Record<BadgeTone, string> = {
  ok: "sync-pop__badge--ok",
  busy: "sync-pop__badge--busy",
  warn: "sync-pop__badge--warn",
  danger: "sync-pop__badge--danger",
  muted: "sync-pop__badge--muted",
};

/** Progressive labels while an action runs (text-button rule, ui/Loading.tsx). */
const BUSY_LABELS: Partial<Record<PopoverAction, string>> = {
  syncNow: "Syncing…", retry: "Syncing…", recheck: "Checking…",
};

/** A popover action button: spinner + progressive label while busy, idle width kept. */
function PopoverButton({ action, primary, busy, disabled, onAction }: {
  action: PopoverAction; primary: boolean; busy: boolean; disabled: boolean; onAction: (a: PopoverAction) => void;
}) {
  const { ref, style } = useLoadingWidth<HTMLButtonElement>(busy);
  const refreshy = action === "syncNow" || action === "retry" || action === "recheck";
  return (
    <button
      ref={ref}
      type="button"
      className={`sync-pop__btn${primary ? " sync-pop__btn--primary" : ""}`}
      data-action={action}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      style={style}
      onClick={() => onAction(action)}
    >
      {refreshy && <BusyIcon icon={RefreshCw} busy={busy} spinSelf size={11} />}
      {busy ? BUSY_LABELS[action] ?? ACTION_LABELS[action] : ACTION_LABELS[action]}
    </button>
  );
}

const POP_W = 300;
const POP_MAX_H = 360;

function placeFor(anchor: HTMLElement | null): PopoverPos {
  if (anchor?.isConnected) return computePopoverPos(anchor, { minWidth: POP_W, maxHeight: POP_MAX_H });
  // No anchor on screen: bottom-right, above the status bar.
  const width = Math.min(POP_W, window.innerWidth - 16);
  return { bottom: 30, left: Math.max(8, window.innerWidth - width - 8), width, flipUp: true };
}

const focusables = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])"));

export interface SyncPopoverPanelProps {
  model: PopoverModel;
  anchor: HTMLElement | null;
  deviceCount: number | null;
  /** The action running right now (spinner + disabled). */
  busy: PopoverAction | null;
  connecting: boolean;
  connectError: string | null;
  onAction: (a: PopoverAction) => void;
  onCancelConnect: () => void;
  onClose: () => void;
}

/** The popover itself (exported for tests). Focus moves in on open and back to the anchor on close. */
export function SyncPopoverPanel({
  model, anchor, deviceCount, busy, connecting, connectError, onAction, onCancelConnect, onClose,
}: SyncPopoverPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const [pos, setPos] = useState<PopoverPos>(() => placeFor(anchor));

  useLayoutEffect(() => {
    const update = () => setPos(placeFor(anchor));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [anchor]);

  // Focus in on open; back to the trigger (or whatever had focus) on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) (focusables(panel)[0] ?? panel).focus();
    return () => {
      const back = anchor?.isConnected ? anchor : before?.isConnected ? before : null;
      // Don't steal focus from something the user moved to (e.g. a dialog opened by an action).
      const active = document.activeElement;
      if (back && (!active || active === document.body || panel?.contains(active))) back.focus();
    };
  }, [anchor]);

  useEscapeKey(onClose);
  useClickOutside([panelRef, anchorRef], onClose);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const list = focusables(panelRef.current);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  };

  // "Sync settings" is a link on the right; the other actions are buttons, the first one primary.
  const buttons = model.actions.filter((a) => a !== "settings");
  const hasSettings = model.actions.includes("settings");
  const facts = [model.lastSynced, deviceCount != null && model.showDevices ? deviceCountLabel(deviceCount) : null]
    .filter(Boolean).join(" · ");

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="sync-pop-title"
      tabIndex={-1}
      className="sync-pop"
      data-testid="sync-popover"
      style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <Cloud size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
        <h2 id="sync-pop-title" className="flex-1 m-0 text-[12.5px] font-semibold">Vault Sync</h2>
        <span className={`sync-pop__badge ${TONE_CLASS[model.badge.tone]}`}>{model.badge.label}</span>
        <button type="button" className="vt-icon-btn" aria-label="Close" onClick={onClose}><X size={13} /></button>
      </div>

      <div className="flex flex-col gap-2 px-3 pb-3">
        {model.connected && (
          <div className="flex items-center gap-2.5">
            <span className="sync-pop__avatar" aria-hidden>{model.avatar ?? "G"}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] text-[var(--color-text)]" title={model.account ?? undefined}>
                {model.account ?? "Google account"}
              </div>
              {model.location && <div className="truncate text-[11px] text-[var(--color-text-muted)]">{model.location}</div>}
            </div>
          </div>
        )}
        {facts && <p className="m-0 text-[11.5px] text-[var(--color-text-muted)]">{facts}</p>}
        {connecting ? (
          <p className="m-0 flex items-center gap-1.5 text-[11.5px] text-[var(--color-text-muted)]" role="status">
            <Spinner size={12} />{WAITING_FOR_GOOGLE}
          </p>
        ) : (connectError || model.message) && (
          <p className={`m-0 text-[11.5px] leading-relaxed ${connectError || model.messageTone === "danger" ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`}
             role={connectError || model.messageTone === "danger" ? "alert" : undefined}>
            {connectError ?? model.message}
          </p>
        )}

        {(model.actions.length > 0 || connecting) && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {connecting ? (
              <button type="button" className="sync-pop__btn" onClick={onCancelConnect}>Cancel</button>
            ) : buttons.map((a, i) => {
              // Busy: this action is running, or a sync is already under way (Sync now is disabled meanwhile).
              const spinning = busy === a || (a === "syncNow" && model.badge.tone === "busy" && model.disabled.includes("syncNow"));
              return (
                <PopoverButton key={a} action={a} primary={i === 0} busy={spinning}
                               disabled={model.disabled.includes(a) || busy != null} onAction={onAction} />
              );
            })}
            {!connecting && hasSettings && (
              <button type="button" className="sync-pop__link" data-action="settings" onClick={() => onAction("settings")}>
                {ACTION_LABELS.settings}<ChevronRight size={12} aria-hidden />
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── Host (status + actions) ────────────────────────────────────────────────────

/**
 * Mounted once (in the status bar). Listens for `notiq:open-sync-popover`, renders the popover for the live
 * status and runs its actions. Off states (not connected / sync off) hand over to the set-up decision flow
 * (`notiq:sync-start-setup`, handled by the new-user flow); Reconnect signs in again right here and keeps
 * waiting when the popover closes.
 */
export function SyncPopoverHost() {
  const { open, anchor, intent, show, close, clearIntent } = useSyncPopoverStore();
  const status = useSyncStatus();
  const statusError = useSyncStore((s) => s.error);
  const [busy, setBusy] = useState<PopoverAction | null>(null);
  const { connecting, error: connectError, connect, cancel } = useSyncConnect((s) => {
    toast.success(`Reconnected to Google Drive${s.account ? ` as ${s.account}` : ""}`);
  });

  useEffect(() => {
    const onOpen = (e: Event) => show((e as CustomEvent<SyncPopoverRequest | undefined>).detail ?? undefined);
    window.addEventListener(OPEN_SYNC_POPOVER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SYNC_POPOVER_EVENT, onOpen);
  }, [show]);

  // Opening the popover counts as having seen the one-time indicator tip.
  useEffect(() => { if (open) markIndicatorTipShown(); }, [open]);

  const runNow = useCallback(async (a: PopoverAction) => {
    setBusy(a);
    try { await runSyncNow(); } finally { setBusy(null); }
  }, []);

  const onAction = useCallback((a: PopoverAction) => {
    switch (a) {
      case "syncNow":
      case "retry": void runNow(a); break;
      case "connect":
      case "turnOn": close(); requestSyncSetup(); break; // the decision flow takes over
      case "reconnect": void connect(); break;
      case "recheck":
        setBusy(a);
        void Promise.resolve(useSyncStore.getState().refresh()).finally(() => setBusy(null));
        break;
      case "review": close(); useDeletionGuardUi.getState().reopen(); break;
      case "unlock": close(); void useVaultStore.getState().ensureUnlocked(); break;
      case "openStorage": openUrl(DRIVE_STORAGE_URL).catch((e) => toast.error(String(e))); break;
      case "settings": close(); useAppStore.getState().openSettings("vault", syncSettingsRow(useSyncStore.getState().status)); break;
    }
  }, [runNow, connect, close]);

  // `openSyncPopover({ action: "connect" })`: hand over to the set-up flow right away.
  useEffect(() => {
    if (!open || !intent) return;
    clearIntent();
    if (intent === "connect" && status?.configured && !status.provider) { close(); requestSyncSetup(); }
  }, [open, intent, status, close, clearIntent]);

  const model = status ? popoverModel(status) : loadingModel(statusError);
  const deviceCount = useDeviceCount(open && model.showDevices);

  return open ? (
    <SyncPopoverPanel
      model={model}
      anchor={anchor}
      deviceCount={deviceCount}
      busy={busy}
      connecting={connecting}
      connectError={connectError}
      onAction={onAction}
      onCancelConnect={cancel}
      onClose={close}
    />
  ) : null;
}
