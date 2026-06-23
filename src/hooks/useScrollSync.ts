import { useCallback, useRef } from "react";

/**
 * Shared scroll-sync state for both MonacoMarkdownEditor and MarkdownPreview.
 * Prevents echo-back when one pane programmatically sets the other's scroll position.
 */
export function useScrollSync(onScrollChange?: (ratio: number) => void) {
  const isSyncingRef = useRef(false);
  const onScrollChangeRef = useRef(onScrollChange);
  onScrollChangeRef.current = onScrollChange;

  /** Report a user-initiated scroll event (ratio 0..1). Ignored while syncing. */
  const reportScroll = useCallback((ratio: number) => {
    if (isSyncingRef.current) return;
    onScrollChangeRef.current?.(ratio);
  }, []);

  return { isSyncingRef, reportScroll };
}
