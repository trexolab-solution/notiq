import { useEffect } from "react";
import { takeNewEntry } from "../lib/entryFocus";

const TRIES = 12; // frames to wait for a lazily mounted form

/** Focuses and selects the Name field (by element id) when this tab's entry was just created. */
export function useFocusNameOnCreate(path: string | undefined, inputId: string, onNew?: () => void): void {
  useEffect(() => {
    let raf = 0;
    let tries = 0;
    const attempt = () => {
      const el = document.getElementById(inputId) as HTMLInputElement | null;
      if (!el) { if (++tries < TRIES) raf = requestAnimationFrame(attempt); return; }
      if (!takeNewEntry(path)) return;
      onNew?.();
      el.focus();
      el.select();
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `onNew` is read when the mark is taken
  }, [path, inputId]);
}
