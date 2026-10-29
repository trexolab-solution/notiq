/**
 * App-wide notifications (VS Code style). Backward compatible with the old
 * toast API: `toast.error(msg)` and `toast.error(msg, 9000)` still work; the
 * second argument may also be an options object (title, detail, actions, id,
 * source, silent, progress). Logic lives in ./notifications.
 */
import * as N from "./notifications";
import type { Notification, NotificationType, NotifyOptions, NotificationPatch } from "./notifications";

export type ToastType = NotificationType;
export type ToastItem = Notification;
export type ToastOptions = NotifyOptions;
export type { NotificationAction as ToastAction } from "./notifications";

type Arg = number | NotifyOptions;

/** Subscribe to the on-screen notifications. Returns an unsubscribe function. */
function subscribe(l: (items: ToastItem[]) => void): () => void {
  return N.subscribe((s) => l(s.toasts));
}

export const toast = {
  info:    (msg: string, opts?: Arg) => N.notify("info",    msg, opts),
  success: (msg: string, opts?: Arg) => N.notify("success", msg, opts),
  warning: (msg: string, opts?: Arg) => N.notify("warning", msg, opts),
  error:   (msg: string, opts?: Arg) => N.notify("error",   msg, opts),
  update:  (id: string, patch: NotificationPatch) => N.update(id, patch),
  /** Take it off the screen (it stays in the Notification Center). */
  dismiss: (id: string) => N.dismiss(id),
  /** Remove it everywhere, history included (transient "working…" notices). */
  remove:  (id: string) => N.remove(id),
  clear:   () => N.clear(),
  subscribe,
};
