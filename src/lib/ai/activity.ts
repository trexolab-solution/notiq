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
