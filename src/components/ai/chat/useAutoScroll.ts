import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Whether the message list is "pinned" to the latest message — mirrors
 * ChatGPT/Claude: streamed tokens only autoscroll while the user hasn't
 * scrolled away to read something earlier.
 *
 * `pinned` is exposed as state (for render) and `scrollIfPinned` reads it via a
 * ref, so a caller can re-run "scroll to bottom if still pinned" from an effect
 * keyed on message changes without needing `pinned` itself in that effect's deps.
 */
export function useAutoScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);

  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  useEffect(() => { pinnedRef.current = pinned; }, [pinned]);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  // Track how close to the bottom the user has scrolled; only "pinned" when
  // within a small threshold, so autoscroll disengages the moment they read up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setPinned(distanceFromBottom < 80);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const scrollIfPinned = useCallback(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [scrollToBottom]);

  return { scrollRef, pinned, setPinned, scrollToBottom, scrollIfPinned };
}
