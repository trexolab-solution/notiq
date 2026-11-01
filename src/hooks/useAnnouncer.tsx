import { useCallback, useEffect, useRef, useState } from "react";

/** Polite live region. `announce` replaces its text; repeating the same message still gets read. */
export function useAnnouncer() {
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const announce = useCallback((text: string) => {
    setMsg("");
    if (timer.current) clearTimeout(timer.current);
    // A tick later, so an identical message is still a DOM change screen readers pick up.
    timer.current = setTimeout(() => setMsg(text), 30);
  }, []);
  const region = <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{msg}</div>;
  return { announce, region };
}
