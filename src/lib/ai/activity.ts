// Tiny pub/sub so non-React code (the Monaco inline-completion provider, AI
// actions) can signal "AI is working". The inline shimmer loader subscribes to
// the "thinking" state — it shows while a request is in flight BUT no text is
// streaming yet. Once tokens start arriving, the streamed text is the feedback,
// so the shimmer hides to avoid a double "AI busy" signal.

type Listener = (showLoader: boolean) => void;

let _count = 0;        // in-flight operations (any AI work)
let _streamCount = 0;  // operations currently streaming text into the editor
let _loader = false;   // derived: a request is thinking (in flight, not streaming)
const listeners = new Set<Listener>();

// Cancelers for in-flight operations. Esc → cancelAll().
const cancelers = new Set<() => void>();

/** Loader shows when something is running and nothing is streaming yet. */
function emit() {
  const next = _count > 0 && _streamCount === 0;
  if (next === _loader) return;
  _loader = next;
  listeners.forEach((l) => l(_loader));
}

export const aiActivity = {
  /** Mark one AI request as started. */
  start() { _count++; emit(); },
  /** Mark one AI request as finished. */
  end() { _count = Math.max(0, _count - 1); emit(); },

  /** Mark the transition into the text-streaming phase (hides the shimmer). */
  beginStream() { _streamCount++; emit(); },
  /** Mark the end of the text-streaming phase. */
  endStream() { _streamCount = Math.max(0, _streamCount - 1); emit(); },

  /** Run an async fn while showing the indicator. */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    aiActivity.start();
    try { return await fn(); }
    finally { aiActivity.end(); }
  },

  /** True while any AI work is in flight (drives Esc-to-cancel). */
  isActive() { return _count > 0; },

  /** Subscribe to the shimmer-loader state (thinking, not streaming). */
  subscribe(l: Listener): () => void {
    listeners.add(l);
    l(_loader);
    return () => { listeners.delete(l); };
  },

  /** Register a cancel fn for an in-flight op; returns an unregister fn. */
  registerCanceler(fn: () => void): () => void {
    cancelers.add(fn);
    return () => { cancelers.delete(fn); };
  },
  /** Cancel every in-flight op (e.g. user pressed Esc). Returns true if any ran. */
  cancelAll(): boolean {
    if (cancelers.size === 0) return false;
    cancelers.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    cancelers.clear();
    return true;
  },
};

/**
 * Subscribe to the AI-busy state with "professional" timing so indicators never
 * flicker. `onChange(true)` fires only once a request has been pending past
 * `showDelayMs` (fast work finishes first and never flashes anything), and once
 * shown it stays at least `minVisibleMs` before `onChange(false)` so it fades in
 * and out smoothly instead of blinking. Returns an unsubscribe fn.
 *
 * Shared by the editor overlay chip (inlineLoader) and the status-bar item so
 * both behave identically.
 */
export function subscribeBusyDelayed(
  onChange: (visible: boolean) => void,
  opts: { showDelayMs?: number; minVisibleMs?: number } = {},
): () => void {
  const showDelayMs = opts.showDelayMs ?? 180;
  const minVisibleMs = opts.minVisibleMs ?? 320;
  let visible = false;
  let shownAt = 0;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  };

  const onBusy = (busy: boolean) => {
    if (busy) {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (visible || showTimer) return;
      showTimer = setTimeout(() => {
        showTimer = null;
        visible = true;
        shownAt = Date.now();
        onChange(true);
      }, showDelayMs);
    } else {
      if (showTimer) { clearTimeout(showTimer); showTimer = null; }
      if (!visible) return;
      const wait = Math.max(0, minVisibleMs - (Date.now() - shownAt));
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        hideTimer = null;
        visible = false;
        onChange(false);
      }, wait);
    }
  };

  const unsub = aiActivity.subscribe(onBusy);
  return () => { clearTimers(); unsub(); };
}
