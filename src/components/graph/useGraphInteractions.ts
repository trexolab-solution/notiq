import { useCallback, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { Cv, FgNode } from "./graphData";
import type { NodeMats } from "./graphVisuals";

interface UseGraphInteractionsParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ForceGraph3D ref has no public types
  graphRef: MutableRefObject<Record<string, any> | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  navigateToNote: (tabId: string, searchText?: string) => void;
  cvRef: MutableRefObject<Cv>;
  nodeMatRefs: MutableRefObject<Map<string, NodeMats>>;
  hoveredNodeRef: MutableRefObject<string | null>;
}

/**
 * Node click (single = fly-to, double = open note) and hover (tooltip +
 * scale/fresnel highlight) behaviour for the force graph.
 */
export function useGraphInteractions({
  graphRef, containerRef, navigateToNote, cvRef, nodeMatRefs, hoveredNodeRef,
}: UseGraphInteractionsParams) {
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingClickRef = useRef<FgNode | null>(null);
  const [tooltipData, setTooltipData] = useState<{ name: string; degree: number; id: string } | null>(null);
  const tooltipElemRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef({ x: 0, y: 0 });

  // ── Camera fly-to ──────────────────────────────────────────────────────
  const flyToNode = useCallback((node: FgNode) => {
    const fg = graphRef.current; if (!fg) return;
    const x = node.x ?? 0, y = node.y ?? 0, z = node.z ?? 0;
    const mag = Math.hypot(x, y, z);
    const dist = 85;
    if (mag < 0.5) fg.cameraPosition({ x, y, z: z + dist }, { x, y, z }, 800);
    else { const ratio = (mag + dist) / mag; fg.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, 800); }
  }, []); // Stable: reads from graphRef

  const onNodeClick = useCallback((node: FgNode) => {
    if (clickTimerRef.current && pendingClickRef.current?.id === node.id) {
      clearTimeout(clickTimerRef.current); clickTimerRef.current = null; pendingClickRef.current = null;
      if (node.tabId) navigateToNote(node.tabId, node.name);
    } else {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      pendingClickRef.current = node;
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
        const n = pendingClickRef.current; pendingClickRef.current = null;
        if (n) flyToNode(n);
      }, 350);
    }
  }, [navigateToNote, flyToNode]);

  // ── Hover — scale up + fresnel boost ───────────────────────────────────
  const onNodeHover = useCallback((node: FgNode | null) => {
    const nid = node?.id ?? null;
    const pid = hoveredNodeRef.current;
    hoveredNodeRef.current = nid;
    if (containerRef.current) containerRef.current.style.cursor = node ? "pointer" : "default";
    setTooltipData(node ? { name: node.name || String(node.id), degree: node.degree ?? 0, id: node.id } : null);

    // Reset previous hover
    if (pid && pid !== nid) {
      const m = nodeMatRefs.current.get(pid);
      if (m) {
        m.group.scale.set(1, 1, 1);
        m.shell.uniforms.uOpacity.value = cvRef.current.isLight ? 0.4 : 0.6;
      }
    }
    // Highlight new hover — scale + boost fresnel opacity
    if (nid) {
      const m = nodeMatRefs.current.get(nid);
      if (m) {
        m.group.scale.set(1.15, 1.15, 1.15);
        m.shell.uniforms.uOpacity.value = cvRef.current.isLight ? 0.7 : 0.9;
      }
    }
  }, []); // Stable: reads from refs (containerRef, cvRef, nodeMatRefs, hoveredNodeRef)

  return { onNodeClick, onNodeHover, tooltipData, mouseRef, tooltipElemRef };
}
