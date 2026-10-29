import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import * as N from "../../lib/notifications";
import type { Notification } from "../../lib/notifications";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useClickOutside } from "../../hooks/useClickOutside";
import { NotificationActions, SeverityIcon, useNotificationState } from "./Toast";

/** Re-render every 30 s so "2 min ago" stays honest while the panel is open. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function CenterItem({ n, now }: { n: Notification; now: number }) {
  return (
    <li
      className={`notif-item notif-item--${n.type}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Delete" && e.target === e.currentTarget) { e.preventDefault(); N.remove(n.id); }
      }}
    >
      <SeverityIcon type={n.type} size={15} />
      <div className="notif-body">
        {n.title && <p className="notif-title">{n.title}</p>}
        <p className="notif-message is-expanded">
          {n.message}
          {n.count > 1 && <span className="notif-count" aria-label={`${n.count} times`}>×{n.count}</span>}
        </p>
        {n.detail && (
          <details className="notif-details">
            <summary>Details</summary>
            <pre className="notif-detail">{n.detail}</pre>
          </details>
        )}
        <div className="notif-meta">
          {n.source && <span className="notif-source">{n.source}</span>}
          <time dateTime={new Date(n.updatedAt).toISOString()} title={new Date(n.updatedAt).toLocaleString()}>
            {N.formatRelative(n.updatedAt, now)}
          </time>
        </div>
        <NotificationActions n={n} />
      </div>
      <button type="button" className="notif-close" aria-label="Remove notification" onClick={() => N.remove(n.id)}>
        <X size={14} strokeWidth={2} />
      </button>
    </li>
  );
}

/** Popover listing this session's notifications, anchored above the status-bar bell. */
export function NotificationCenter({ anchorRef }: { anchorRef: React.RefObject<HTMLElement | null> }) {
  const { history, dnd } = useNotificationState();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);
  const now = useNow();
  const close = () => N.setCenterOpen(false);

  useEscapeKey(close);
  useClickOutside([anchorRef, panelRef], close);

  useLayoutEffect(() => {
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({
        right: Math.max(8, window.innerWidth - r.right - 4),
        bottom: Math.max(8, window.innerHeight - r.top + 6),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchorRef]);

  return createPortal(
    <div
      ref={panelRef}
      className="notif-center"
      role="dialog"
      aria-label="Notifications"
      style={pos ? { right: pos.right, bottom: pos.bottom } : { visibility: "hidden" }}
    >
      <header className="notif-center__head">
        <h2>Notifications</h2>
        <label className="notif-dnd">
          <span>Do not disturb</span>
          <button
            type="button"
            role="switch"
            aria-checked={dnd}
            className="notif-switch"
            onClick={() => N.setDnd(!dnd)}
          >
            <span className="notif-switch__thumb" />
          </button>
        </label>
        <button type="button" className="notif-link" onClick={() => N.clear()} disabled={history.length === 0}>
          Clear all
        </button>
      </header>

      {dnd && (
        <p className="notif-center__note">Pop-ups are paused. New notifications still collect here.</p>
      )}

      {history.length === 0 ? (
        <div className="notif-center__empty">
          <p>No notifications</p>
          <p>Messages from saving, syncing and the vault will collect here.</p>
        </div>
      ) : (
        <ul className="notif-center__list">
          {history.map((n) => <CenterItem key={n.id} n={n} now={now} />)}
        </ul>
      )}
    </div>,
    document.body,
  );
}
