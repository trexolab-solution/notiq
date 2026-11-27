import { PenTool } from "lucide-react";

/** Shown while the whiteboard loads. */
export function ViewLoader() {
  return (
    <div className="vl-root">

      <div className="vl-wb-grid" />
      <div className="vl-wb-shape" style={{ width: 180, height: 80,  top: "18%",    left:  "12%", animationDelay: "0s"   }} />
      <div className="vl-wb-shape" style={{ width: 140, height: 140, top: "20%",    right: "15%", borderRadius: "50%", animationDelay: "0.6s" }} />
      <div className="vl-wb-shape" style={{ width: 220, height: 70,  bottom: "22%", left:  "22%", animationDelay: "1.1s" }} />
      <div className="vl-wb-shape" style={{ width: 100, height: 100, bottom: "25%", right: "20%", animationDelay: "0.3s" }} />

      {/* Centre badge + spinner + label */}
      <div className="vl-center">
        <div className="vl-badge"><PenTool size={24} strokeWidth={1.6} /></div>
        <div className="vl-spinner" />
        <span className="vl-label">Loading Whiteboard</span>
      </div>

    </div>
  );
}
