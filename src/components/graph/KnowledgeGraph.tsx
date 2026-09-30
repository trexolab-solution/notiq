import React, { useMemo, useRef } from "react";
import { ForceGraph3D } from "../../lib/forceGraph";
import { useAppStore } from "../../store";
import { getCv } from "./graphData";
import { GraphEmptyState } from "./GraphEmptyState";
import { GraphOverlay } from "./GraphOverlay";
import { useGraphContainerSize } from "./useGraphContainerSize";
import { useGraphData } from "./useGraphData";
import { useGraphInteractions } from "./useGraphInteractions";
import { useGraphLinkStyles } from "./useGraphLinkStyles";
import { useGraphNodeVisuals } from "./useGraphNodeVisuals";
import { useGraphSceneSetup } from "./useGraphSceneSetup";

/* ── Graph inner ────────────────────────────────────────────────────────── */
function GraphInner() {
  const graphData = useAppStore((s) => s.graphData);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const navigateToNote = useAppStore((s) => s.navigateToNote);
  const themeId = useAppStore((s) => s.themeId);
  const activeView = useAppStore((s) => s.activeView);

  const cv = useMemo(getCv, [themeId]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ForceGraph3D ref has no public types
  const graphRef = useRef<Record<string, any> | null>(null);
  const activeRef = useRef(activeTabId); activeRef.current = activeTabId;
  const cvRef = useRef(cv); cvRef.current = cv;

  const { containerRef, size, everMeasuredRef } = useGraphContainerSize();
  const { fgData, nodeColorMapRef } = useGraphData(graphData, cv.isLight);
  const { nodeThreeObject, nodeMatRefs, hoveredNodeRef } = useGraphNodeVisuals({
    graphData, activeTabId, activeRef, activeView, cvRef, nodeColorMapRef,
  });
  const {
    linkColorFn, linkWidthFn, linkOpacityFn,
    linkParticlesFn, linkParticleSpeedFn, linkParticleWidthFn, linkParticleColorFn,
  } = useGraphLinkStyles({ activeTabId, activeRef, cvRef, nodeColorMapRef });
  const { onNodeClick, onNodeHover, tooltipData, mouseRef, tooltipElemRef } = useGraphInteractions({
    graphRef, containerRef, navigateToNote, cvRef, nodeMatRefs, hoveredNodeRef,
  });
  useGraphSceneSetup({
    graphRef, cvRef, size, themeId, activeTabId, activeView, nodeCount: graphData.nodes.length,
  });

  if (graphData.nodes.length === 0) return <GraphEmptyState cv={cv} />;

  const stats = `${graphData.nodes.length} note${graphData.nodes.length !== 1 ? "s" : ""} · ${graphData.links.length} link${graphData.links.length !== 1 ? "s" : ""}`;
  const show = size.w > 0 || everMeasuredRef.current;

  return (
    <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", background: cv.bg }}
      onMouseMove={(e) => {
        const x = e.nativeEvent.offsetX, y = e.nativeEvent.offsetY;
        mouseRef.current = { x, y };
        if (tooltipElemRef.current) {
          tooltipElemRef.current.style.left = `${x + 14}px`;
          tooltipElemRef.current.style.top = `${y - 12}px`;
        }
      }}
    >
      {show && (
        <ForceGraph3D ref={graphRef} graphData={fgData} width={Math.max(1, size.w)} height={Math.max(1, size.h)}
          backgroundColor={"rgba(0,0,0,0)"}
          nodeRelSize={4} nodeThreeObject={nodeThreeObject} nodeLabel={() => ""}
          linkColor={linkColorFn} linkWidth={linkWidthFn} linkOpacity={linkOpacityFn}
          linkCurvature={0.1}
          linkDirectionalParticles={linkParticlesFn}
          linkDirectionalParticleWidth={linkParticleWidthFn}
          linkDirectionalParticleSpeed={linkParticleSpeedFn}
          linkDirectionalParticleColor={linkParticleColorFn}
          cooldownTicks={320} d3AlphaDecay={0.016} d3VelocityDecay={0.32}
          onNodeClick={onNodeClick} onNodeHover={onNodeHover}
          enableNodeDrag={true} enableNavigationControls={true} showNavInfo={false}
        />
      )}

      <GraphOverlay
        ref={tooltipElemRef}
        cv={cv}
        stats={stats}
        tooltipData={tooltipData}
        mouseX={mouseRef.current.x}
        mouseY={mouseRef.current.y}
        dotColor={tooltipData ? (nodeColorMapRef.current.get(tooltipData.id) ?? cv.primary) : ""}
        onFitView={() => graphRef.current?.zoomToFit(500, 50)}
      />
    </div>
  );
}

export const KnowledgeGraph = React.memo(function KnowledgeGraph() {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <GraphInner />
    </div>
  );
});
