import React from "react";
import { Maximize2 } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import type { Cv } from "./graphData";

interface GraphOverlayProps {
  cv: Cv;
  /** "N notes · M links" summary shown in the top-left badge */
  stats: string;
  tooltipData: { name: string; degree: number; id: string } | null;
  /** Last known mouse position (container-relative), used to place the tooltip */
  mouseX: number;
  mouseY: number;
  /** Colour of the hovered node's dot in the tooltip */
  dotColor: string;
  onFitView: () => void;
}

/* ── Hover tooltip + stats badge + fit-view button + help hint ──────────── */
export const GraphOverlay = React.forwardRef<HTMLDivElement, GraphOverlayProps>(
  function GraphOverlay({ cv, stats, tooltipData, mouseX, mouseY, dotColor, onFitView }, tooltipElemRef) {
    const overlayBg = cv.isLight ? "rgba(255,255,255,0.82)" : "rgba(15,20,30,0.80)";
    const overlayBorder = cv.isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.08)";

    return (
      <>
        {/* Tooltip with colored dot */}
        {tooltipData && (
          <div ref={tooltipElemRef} role="tooltip" aria-label={tooltipData.name} style={{
            position: "absolute", left: mouseX + 14, top: mouseY - 12,
            zIndex: 20, pointerEvents: "none",
            padding: "6px 12px", borderRadius: 8,
            background: overlayBg, border: `1px solid ${overlayBorder}`,
            backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
            boxShadow: cv.isLight ? "0 2px 8px rgba(0,0,0,0.10)" : "0 2px 12px rgba(0,0,0,0.4)",
            fontSize: 12, color: cv.text, fontWeight: 500, whiteSpace: "nowrap",
          }}>
            <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                background: dotColor,
              }} />
              {tooltipData.name}
            </div>
            <div style={{ color: cv.muted, fontSize: 11, fontWeight: 400, marginTop: 2 }}>
              {tooltipData.degree > 0 ? `${tooltipData.degree} connection${tooltipData.degree !== 1 ? "s" : ""}` : "No connections"}{" "}{"·"} Double-click to open
            </div>
          </div>
        )}

        {/* Stats badge */}
        <div style={{
          position: "absolute", top: 10, left: 10, zIndex: 10, fontSize: 11,
          padding: "5px 12px", borderRadius: 8,
          background: overlayBg, border: `1px solid ${overlayBorder}`,
          color: cv.muted, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          userSelect: "none", pointerEvents: "none",
        }}>
          {stats}
        </div>

        {/* Fit-view button */}
        <Tooltip content="Fit view">
          <button onClick={onFitView}
            style={{
              position: "absolute", top: 10, right: 10, zIndex: 10,
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 30, height: 30, borderRadius: 7,
              border: `1px solid ${overlayBorder}`, background: overlayBg,
              color: cv.muted, cursor: "pointer",
              backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
              transition: "color .12s, border-color .12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = cv.text; e.currentTarget.style.borderColor = cv.primary; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = cv.muted; e.currentTarget.style.borderColor = overlayBorder; }}
          >
            <Maximize2 size={13} />
          </button>
        </Tooltip>

        {/* Help hint */}
        <div style={{
          position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)",
          zIndex: 10, fontSize: 11, padding: "5px 14px", borderRadius: 20,
          background: overlayBg, border: `1px solid ${overlayBorder}`,
          color: cv.muted, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          pointerEvents: "none", userSelect: "none", whiteSpace: "nowrap",
        }}>
          Drag to rotate {"·"} Scroll to zoom {"·"} Click to focus {"·"} Double-click to open note
        </div>
      </>
    );
  },
);
