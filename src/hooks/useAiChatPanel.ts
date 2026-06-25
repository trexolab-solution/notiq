import { useCallback, useEffect, useRef, useState } from "react";

/**
 * AI chat panel width + edge-drag resize. The panel is docked on the right, so
 * its width grows as the cursor moves left. Clamped to 280–640px and persisted.
 */
export function useAiChatPanel() {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("pref:aiChatWidth"));
    return saved >= 280 && saved <= 640 ? saved : 360;
  });
  const draggingRef = useRef(false);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const w = Math.min(640, Math.max(280, window.innerWidth - e.clientX));
      setWidth(w);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("pref:aiChatWidth", String(width));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [width]);

  return { width, startResize };
}
