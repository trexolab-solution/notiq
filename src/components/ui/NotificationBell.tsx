import { useRef } from "react";
import { Bell, BellDot, BellOff } from "lucide-react";
import * as N from "../../lib/notifications";
import { Tooltip } from "./Tooltip";
import { useNotificationState } from "./Toast";
import { NotificationCenter } from "./NotificationCenter";

/** Status-bar bell: unread badge, opens the Notification Center above it. */
export function NotificationBell() {
  const { unread, dnd, centerOpen } = useNotificationState();
  const btnRef = useRef<HTMLButtonElement>(null);
  const Icon = dnd ? BellOff : unread > 0 ? BellDot : Bell;
  const label = `Notifications${unread ? `, ${unread} unread` : ""}${dnd ? ", do not disturb on" : ""}`;

  return (
    <>
      <Tooltip content={dnd ? "Notifications (Do not disturb)" : "Notifications"} disabled={centerOpen}>
        <button
          ref={btnRef}
          type="button"
          className={`status-bell${centerOpen ? " is-active" : ""}${unread ? " has-unread" : ""}`}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={centerOpen}
          onClick={() => N.setCenterOpen(!centerOpen)}
        >
          <Icon size={13} strokeWidth={2} />
          {unread > 0 && <span className="status-bell__badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
        </button>
      </Tooltip>
      {centerOpen && <NotificationCenter anchorRef={btnRef} />}
    </>
  );
}
