import { useCallback, useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * Copy text to the clipboard and expose a transient `copied` flag that flips
 * back after `resetDelay` ms. Replaces the repeated
 * `writeText(…).then(() => { setCopied(true); setTimeout(…, 1500) })` blocks,
 * and adds the timer cleanup the inline versions were missing.
 *
 * `copy` resolves to `true` on success / `false` on failure so callers can
 * decide whether to surface an error (some show a toast, some stay silent).
 */
export function useCopyToClipboard(resetDelay = 1500) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => { if (timerRef.current) clearTimeout(timerRef.current); },
    [],
  );

  const copy = useCallback(async (text: string): Promise<boolean> => {
    try {
      await writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), resetDelay);
      return true;
    } catch {
      return false;
    }
  }, [resetDelay]);

  return { copied, copy };
}
