import { useEffect, useMemo, useRef } from "react";
import type { GraphData } from "../../types";
import { degreeMap, nodeColor } from "./graphData";

/**
 * Shapes the store's `GraphData` (notes + wikilinks) into the node/link
 * arrays ForceGraph3D consumes, and maintains a per-node colour map keyed by
 * node id (stable across renders so hover/link callbacks can look it up
 * without recomputing).
 */
export function useGraphData(graphData: GraphData, isLight: boolean) {
  const deg = useMemo(() => degreeMap(graphData.nodes, graphData.links), [graphData]);

  const nodeColorMapRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const m = new Map<string, string>();
    graphData.nodes.forEach(n => m.set(n.id, nodeColor(n.id, isLight)));
    nodeColorMapRef.current = m;
  }, [graphData.nodes, deg, isLight]);

  const fgNodes = useMemo(() => graphData.nodes.map(n => {
    const d = deg[n.id] ?? 0;
    return { id: n.id, name: n.name, tabId: n.tabId, degree: d, val: 1 + d * 0.4 };
  }), [graphData.nodes, deg]);
  const fgLinks = useMemo(() => graphData.links.map(l => ({ source: l.source, target: l.target })), [graphData.links]);
  const fgData = useMemo(() => ({ nodes: fgNodes, links: fgLinks }), [fgNodes, fgLinks]);

  return { fgData, nodeColorMapRef };
}
