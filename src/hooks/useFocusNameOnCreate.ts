import { useEffect } from "react";
import { takeNewEntry } from "../lib/entryFocus";

const TRIES = 12; // frames to wait for a lazily mounted form

/** Focuses and selects the Name field (by element id) when this tab's entry was just created. */
export function useFocusNameOnCreate(path: string | undefined, inputId: string): void {
  useEffect(() => {
    let raf = 0;
    let tries = 0;
    const attempt = () => {
      const el = document.getElementById(inputId) as HTMLInputElement | null;
      if (!el) { if (++tries < TRIES) raf = requestAnimationFrame(attempt); return; }
      if (!takeNewEntry(path)) return;
      el.focus();
      el.select();
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [path, inputId]);
}
