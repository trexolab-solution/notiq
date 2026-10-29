import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { X, CircleCheck, TriangleAlert, CircleAlert, Info, type LucideIcon } from "lucide-react";
import * as N from "../../lib/notifications";
import type { Notification, NotificationType } from "../../lib/notifications";

/** Live notification state (on-screen stack, history, unread, DND, center open). */
export function useNotificationState(): N.NotificationState {
  return useSyncExternalStore(N.subscribeStore, N.getState, N.getState);
}

const ICON: Record<NotificationType, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
};
const LABEL: Record<NotificationType, string> = { info: "Info", success: "Success", warning: "Warning", error: "Error" };

export function SeverityIcon({ type, size = 16 }: { type: NotificationType; size?: number }) {
  const Icon = ICON[type];
  return (
    <span className={`notif-icon notif-icon--${type}`} role="img" aria-label={LABEL[type]}>
      <Icon size={size} strokeWidth={2} />
    </span>
  );
}

/** Action buttons; the first is primary unless one is marked explicitly. */
export function NotificationActions({ n }: { n: Notification }) {
  if (!n.actions?.length) return null;
  const explicit = n.actions.some((a) => a.primary);
  return (
    <div className="notif-actions">
      {n.actions.map((a, i) => {
        const primary = explicit ? !!a.primary : i === 0;
        return (
          <button
            key={`${a.label}-${i}`}
            type="button"
            className={`notif-btn${primary ? " notif-btn--primary" : ""}`}
            onClick={() => N.runAction(n.id, a)}
          >
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

function ToastCard({ n }: { n: Notification }) {
  const msgRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const hovered = useRef(false);
  const focused = useRef(false);

  useLayoutEffect(() => {
    const el = msgRef.current;
    if (el && !expanded) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [n.message, expanded]);

  // A card can unmount while hovered (pushed into the overflow): don't leave it frozen.
  useEffect(() => () => { if (hovered.current || focused.current) N.resume(n.id); }, [n.id]);

  const syncPause = () => (hovered.current || focused.current ? N.pause(n.id) : N.resume(n.id));
  const canExpand = clamped || !!n.detail || expanded;
  const showCountdown = n.countdownMs != null && n.progress == null && n.countdownTotal > 0;

  return (
    <div
      className={`notif-toast notif-toast--${n.type}`}
      role={n.type === "error" ? "alert" : "status"}
      tabIndex={0}
      aria-label={n.title ? `${n.title}: ${n.message}` : undefined}
      onMouseEnter={() => { hovered.current = true; syncPause(); }}
      onMouseLeave={() => { hovered.current = false; syncPause(); }}
      onFocus={() => { focused.current = true; syncPause(); }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        focused.current = false; syncPause();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        N.dismiss(n.id);
      }}
    >
      <div className="notif-row">
        <SeverityIcon type={n.type} />
        <div className="notif-body">
          {n.title && <p className="notif-title">{n.title}</p>}
          <p ref={msgRef} className={`notif-message${expanded ? " is-expanded" : ""}`}>
            {n.message}
            {n.count > 1 && <span className="notif-count" aria-label={`${n.count} times`}>×{n.count}</span>}
          </p>
          {expanded && n.detail && <pre className="notif-detail">{n.detail}</pre>}
          {canExpand && (
            <button type="button" className="notif-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
        <button type="button" className="notif-close" aria-label="Dismiss notification" onClick={() => N.dismiss(n.id)}>
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      {(n.source || n.actions?.length) && (
        <div className="notif-footer">
          {n.source ? <span className="notif-source">{n.source}</span> : <span />}
          <NotificationActions n={n} />
        </div>
      )}

      {n.progress != null && (
        <div className="notif-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(n.progress * 100)}>
          <span style={{ transform: `scaleX(${n.progress})` }} />
        </div>
      )}
      {showCountdown && (
        <div className="notif-countdown" aria-hidden="true">
          <span
            key={n.timerEpoch}
            style={{
              "--notif-from": String(n.countdownMs! / n.countdownTotal),
              animationDuration: `${n.countdownMs}ms`,
              animationPlayState: n.paused ? "paused" : "running",
            } as React.CSSProperties}
          />
        </div>
      )}
    </div>
  );
}

/** Renders the global notification stack. Mount once in App root. */
export function ToastProvider() {
  const s = useNotificationState();
  const hidden = s.centerOpen;

  return createPortal(
    <section className="notif-stack" aria-live="polite" aria-relevant="additions text" aria-label="Notifications" hidden={hidden}>
      {s.overflow > 0 && (
        <button type="button" className="notif-overflow" onClick={() => N.setCenterOpen(true)}>
          +{s.overflow} more notification{s.overflow === 1 ? "" : "s"}
        </button>
      )}
      {s.toasts.map((n) => <ToastCard key={n.id} n={n} />)}
    </section>,
    document.body,
  );
}
