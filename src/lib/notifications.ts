/**
 * Notification store: the logic behind `toast.*`, the on-screen notification
 * stack and the status-bar Notification Center.
 *
 * Framework-free (no React, no store, no DOM) so it runs under vitest's node
 * environment with fake timers. History lives in memory only: messages can
 * carry file paths and hostnames, so nothing here touches localStorage.
 */

export type NotificationType = "info" | "success" | "warning" | "error";

export interface NotificationAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface NotifyOptions {
  /** Auto-dismiss delay in ms. `0` = sticky (stays until dismissed). */
  duration?: number;
  /** Bold line above the message. */
  title?: string;
  /** Extra text, collapsed behind "Show more". */
  detail?: string;
  actions?: NotificationAction[];
  /** Same id updates the existing notification instead of adding another. */
  id?: string;
  /** Small origin label, e.g. "Vault". */
  source?: string;
  /** Record in the Notification Center only; no pop-up. */
  silent?: boolean;
  /** 0..1 shows a determinate progress bar; `null` removes it. */
  progress?: number | null;
}

export type NotificationPatch = Partial<Omit<NotifyOptions, "id" | "silent">> & {
  message?: string;
  type?: NotificationType;
};

export interface Notification {
  id: string;
  type: NotificationType;
  message: string;
  title?: string;
  detail?: string;
  actions?: NotificationAction[];
  source?: string;
  progress?: number | null;
  /** Number of identical notifications folded into this one (×N badge). */
  count: number;
  createdAt: number;
  updatedAt: number;
  read: boolean;
  /** Currently in the pop-up stack (shown or waiting in the overflow). */
  onScreen: boolean;
  /** Resolved auto-dismiss duration (0 = sticky / keep-alive). */
  duration: number;
  /** Has actions/detail and no explicit duration: lives until hovered away + 10 s. */
  keepAlive: boolean;
  /** Pointer or focus is on it: its timer is frozen. */
  paused: boolean;
  /** Bumped whenever the countdown restarts (UI re-keys its countdown bar). */
  timerEpoch: number;
  /** ms left on the countdown when it was last (re)started, or null if no countdown runs. */
  countdownMs: number | null;
  /** Full length of the current countdown (for the countdown bar's scale). */
  countdownTotal: number;
}

export interface NotificationState {
  /** On-screen notifications actually shown (max `MAX_VISIBLE`), oldest first. */
  toasts: Notification[];
  /** On-screen notifications waiting behind the shown ones. */
  overflow: number;
  /** Every notification of this session, newest first (cap `HISTORY_CAP`). */
  history: Notification[];
  unread: number;
  dnd: boolean;
  centerOpen: boolean;
}

export const DEFAULT_DURATION: Record<NotificationType, number> = {
  success: 4000,
  info: 4000,
  warning: 7000,
  error: 9000,
};
export const KEEP_ALIVE_AFTER_LEAVE = 10_000;
export const MAX_VISIBLE = 3;
export const HISTORY_CAP = 100;

// ── internal state ───────────────────────────────────────────────────────────

let history: Notification[] = [];
let dnd = false;
let centerOpen = false;
let seq = 0;

interface Timer { handle: ReturnType<typeof setTimeout>; startedAt: number; remaining: number }
const timers = new Map<string, Timer>();
/** ms still owed to a paused / overflowed notification. */
const owed = new Map<string, number>();

type Listener = (s: NotificationState) => void;
const listeners = new Set<Listener>();
let snapshot: NotificationState = build();

function build(): NotificationState {
  const live = history.filter((n) => n.onScreen).reverse(); // oldest first
  const shown = live.slice(-MAX_VISIBLE);
  return {
    toasts: shown,
    overflow: live.length - shown.length,
    history,
    unread: history.reduce((k, n) => k + (n.read ? 0 : 1), 0),
    dnd,
    centerOpen,
  };
}

function emit() {
  syncTimers();
  snapshot = build();
  listeners.forEach((l) => l(snapshot));
}

/** Replace one notification immutably (keeps React snapshots honest). */
function patch(id: string, p: Partial<Notification>): Notification | undefined {
  let out: Notification | undefined;
  history = history.map((n) => (n.id === id ? (out = { ...n, ...p }) : n));
  return out;
}

// ── timers ───────────────────────────────────────────────────────────────────

function clearTimer(id: string, keepOwed: boolean) {
  const t = timers.get(id);
  if (!t) return;
  clearTimeout(t.handle);
  timers.delete(id);
  if (keepOwed) owed.set(id, Math.max(0, t.remaining - (Date.now() - t.startedAt)));
}

function startTimer(id: string, ms: number) {
  clearTimer(id, false);
  owed.delete(id);
  timers.set(id, { handle: setTimeout(() => dismiss(id), ms), startedAt: Date.now(), remaining: ms });
}

/** A fresh full countdown (new / dedupe / update-by-id / keep-alive after leave). */
function resetCountdown(n: Notification): Partial<Notification> {
  clearTimer(n.id, false);
  const ms = n.keepAlive ? null : n.duration > 0 ? n.duration : null;
  if (ms == null) owed.delete(n.id); else owed.set(n.id, ms);
  return { countdownMs: ms, countdownTotal: ms ?? 0, timerEpoch: n.timerEpoch + 1 };
}

/**
 * Only the shown, un-paused notifications count down. Overflowed and paused
 * ones keep the time they are owed and resume from there.
 */
function syncTimers() {
  const s = build();
  const shownIds = new Set(s.toasts.map((n) => n.id));
  for (const n of history) {
    const shouldRun = shownIds.has(n.id) && !n.paused && !centerOpen && owed.has(n.id) && !timers.has(n.id);
    const shouldStop = timers.has(n.id) && (!shownIds.has(n.id) || n.paused || centerOpen);
    if (shouldStop) {
      clearTimer(n.id, true);
    } else if (shouldRun) {
      const ms = owed.get(n.id)!;
      startTimer(n.id, ms);
      history = history.map((h) => (h.id === n.id ? { ...h, countdownMs: ms, timerEpoch: h.timerEpoch + 1 } : h));
    }
  }
  for (const id of [...timers.keys()]) if (!history.some((n) => n.id === id)) clearTimer(id, false);
}

// ── public operations ────────────────────────────────────────────────────────

function resolveDuration(type: NotificationType, o: NotifyOptions): { duration: number; keepAlive: boolean } {
  if (o.duration !== undefined) return { duration: Math.max(0, o.duration), keepAlive: false };
  const keepAlive = !!(o.actions?.length || o.detail);
  return { duration: keepAlive ? 0 : DEFAULT_DURATION[type], keepAlive };
}

function clampProgress(p: number | null | undefined) {
  return p == null ? p : Math.min(1, Math.max(0, p));
}

export function notify(type: NotificationType, message: string, opts: number | NotifyOptions = {}): string {
  const o: NotifyOptions = typeof opts === "number" ? { duration: opts } : opts ?? {};
  const now = Date.now();
  const popUp = !o.silent && !dnd;
  const read = centerOpen;

  // 1) Same id → update in place (and re-pop if it had been dismissed).
  if (o.id) {
    const existing = history.find((n) => n.id === o.id);
    if (existing) {
      const { duration, keepAlive } = resolveDuration(type, o);
      const next: Notification = {
        ...existing,
        type, message, duration, keepAlive,
        title: o.title, detail: o.detail, actions: o.actions, source: o.source,
        progress: clampProgress(o.progress),
        updatedAt: now,
        read: existing.read && read,
        onScreen: existing.onScreen || popUp,
      };
      history = [next, ...history.filter((n) => n.id !== o.id)];
      if (next.onScreen) patch(next.id, resetCountdown(next));
      emit();
      return next.id;
    }
  }

  // 2) Identical (type + message) already on screen → ×N badge, restart timer.
  const dup = history.find((n) => n.onScreen && n.type === type && n.message === message && !o.id);
  if (dup && popUp) {
    const bumped = patch(dup.id, { count: dup.count + 1, updatedAt: now, read: dup.read && read })!;
    patch(dup.id, resetCountdown(bumped));
    emit();
    return dup.id;
  }

  // 3) New notification.
  const { duration, keepAlive } = resolveDuration(type, o);
  const n: Notification = {
    id: o.id ?? `n${++seq}-${now.toString(36)}`,
    type, message,
    title: o.title, detail: o.detail, actions: o.actions, source: o.source,
    progress: clampProgress(o.progress),
    count: 1,
    createdAt: now, updatedAt: now,
    read,
    onScreen: popUp,
    duration, keepAlive,
    paused: false,
    timerEpoch: 0,
    countdownMs: null,
    countdownTotal: 0,
  };
  history = [n, ...history];
  if (popUp) Object.assign(n, resetCountdown(n));
  // Cap the history; drop the oldest.
  if (history.length > HISTORY_CAP) {
    for (const old of history.slice(HISTORY_CAP)) { clearTimer(old.id, false); owed.delete(old.id); }
    history = history.slice(0, HISTORY_CAP);
  }
  emit();
  return n.id;
}

/** Patch an existing notification without re-popping it. */
export function update(id: string, p: NotificationPatch): void {
  const n = history.find((x) => x.id === id);
  if (!n) return;
  const next: Partial<Notification> = { updatedAt: Date.now() };
  if (p.message !== undefined) next.message = p.message;
  if (p.type !== undefined) next.type = p.type;
  if ("title" in p) next.title = p.title;
  if ("detail" in p) next.detail = p.detail;
  if ("actions" in p) next.actions = p.actions;
  if ("source" in p) next.source = p.source;
  if ("progress" in p) next.progress = clampProgress(p.progress);
  const merged = patch(id, next)!;
  if (p.duration !== undefined) {
    const withDur = patch(id, { duration: Math.max(0, p.duration), keepAlive: false })!;
    if (merged.onScreen) patch(id, resetCountdown(withDur));
  }
  emit();
}

/** Remove from the screen; it stays in the Notification Center history. */
export function dismiss(id: string): void {
  const n = history.find((x) => x.id === id);
  clearTimer(id, false);
  owed.delete(id);
  if (!n || !n.onScreen) return;
  patch(id, { onScreen: false, paused: false });
  emit();
}

/** Remove entirely (screen + history). For transient "working…" notices. */
export function remove(id: string): void {
  clearTimer(id, false);
  owed.delete(id);
  if (!history.some((n) => n.id === id)) return;
  history = history.filter((n) => n.id !== id);
  emit();
}

/** Clear the screen and the history. */
export function clear(): void {
  for (const id of [...timers.keys()]) clearTimer(id, false);
  owed.clear();
  history = [];
  emit();
}

/** Pointer entered / focus moved into a notification: freeze its timer. */
export function pause(id: string): void {
  const n = history.find((x) => x.id === id);
  if (!n || n.paused) return;
  patch(id, { paused: true });
  emit();
}

/** Pointer left and focus is elsewhere: resume (keep-alive ones get 10 s). */
export function resume(id: string): void {
  const n = history.find((x) => x.id === id);
  if (!n || !n.paused) return;
  const p: Partial<Notification> = { paused: false };
  if (n.keepAlive && n.onScreen) {
    clearTimer(id, false);
    owed.set(id, KEEP_ALIVE_AFTER_LEAVE);
    p.countdownTotal = KEEP_ALIVE_AFTER_LEAVE;
  }
  patch(id, p);
  emit();
}

export function setDnd(on: boolean): void {
  if (dnd === on) return;
  dnd = on;
  emit();
}

export function markAllRead(): void {
  if (!history.some((n) => !n.read)) return;
  history = history.map((n) => (n.read ? n : { ...n, read: true }));
  emit();
}

export function setCenterOpen(open: boolean): void {
  if (centerOpen === open) return;
  centerOpen = open;
  if (open) history = history.map((n) => (n.read ? n : { ...n, read: true }));
  emit();
}

/** Run an action and take the notification off the screen. */
export function runAction(id: string, action: NotificationAction): void {
  try { action.onClick(); } finally { dismiss(id); }
}

export function getState(): NotificationState { return snapshot; }

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(snapshot);
  return () => { listeners.delete(l); };
}

/** For `useSyncExternalStore`: subscribe without the immediate call. */
export function subscribeStore(cb: () => void): () => void {
  const l: Listener = () => cb();
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** "just now", "2 min ago", "3 h ago", "yesterday", "4 days ago". */
export function formatRelative(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** Test-only: wipe all state. */
export function __resetForTests(): void {
  for (const id of [...timers.keys()]) clearTimer(id, false);
  owed.clear();
  history = [];
  dnd = false;
  centerOpen = false;
  seq = 0;
  listeners.clear();
  snapshot = build();
}
