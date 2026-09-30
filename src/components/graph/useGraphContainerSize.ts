import { useEffect, useRef, useState } from "react";

/**
 * Tracks a container element's pixel size via ResizeObserver, for sizing the
 * ForceGraph3D canvas. `everMeasuredRef` stays true once a non-zero size has
 * been observed, so the graph keeps rendering even if it later shrinks to 0
 * (e.g. a hidden tab).
 */
export function useGraphContainerSize() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const everMeasuredRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const obs = new ResizeObserver((e) => {
      const { width: w, height: h } = e[0].contentRect;
      if (w > 0 && h > 0) everMeasuredRef.current = true;
      setSize({ w: Math.round(w), h: Math.round(h) });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return { containerRef, size, everMeasuredRef };
}
