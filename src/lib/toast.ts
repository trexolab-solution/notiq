export type ToastType = "info" | "success" | "warning" | "error";

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
}

type Listener = (items: ToastItem[]) => void;

let _items: ToastItem[] = [];
const _listeners = new Set<Listener>();

function _notify() { _listeners.forEach((l) => l(_items)); }

function show(type: ToastType, message: string, duration = 3200): string {
  const id = Math.random().toString(36).slice(2);
  _items   = [..._items, { id, type, message, duration }];
  _notify();
  if (duration > 0) setTimeout(() => dismiss(id), duration);
  return id;
}

function dismiss(id: string) {
  _items = _items.filter((t) => t.id !== id);
  _notify();
}

/** Subscribe to toast list changes. Returns an unsubscribe function. */
function subscribe(l: Listener): () => void {
  _listeners.add(l);
  l(_items);
  return () => _listeners.delete(l);
}

export const toast = {
  info:    (msg: string, dur?: number) => show("info",    msg, dur),
  success: (msg: string, dur?: number) => show("success", msg, dur),
  warning: (msg: string, dur?: number) => show("warning", msg, dur),
  error:   (msg: string, dur?: number) => show("error",   msg, dur),
  dismiss,
  subscribe,
};
