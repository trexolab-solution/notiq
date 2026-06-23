import { Network, PenTool } from "lucide-react";

// Pre-computed skeleton layout — nodes [cx, cy, r] in a 1000×640 SVG space
const GN: [number, number, number][] = [
  [160, 180, 20], [360, 110, 28], [600, 210, 22],
  [830, 155, 16], [230, 470, 24], [510, 545, 30],
  [760, 490, 20], [910, 360, 22], [455, 335, 26],
];
const GE: [number, number][] = [
  [0,1],[1,2],[2,3],[0,4],[4,5],[5,6],[5,8],[2,8],[6,7],[1,8],[3,7],[4,8],
];

export function ViewLoader({ view }: { view: "graph" | "whiteboard" }) {
  const isGraph = view === "graph";
  return (
    <div className="vl-root">

      {/* Per-view background skeleton */}
      {isGraph ? (
        <svg className="vl-bg" viewBox="0 0 1000 640" preserveAspectRatio="xMidYMid slice" aria-hidden>
          {GE.map(([a, b], i) => (
            <line key={i} className="vl-graph-edge"
              x1={GN[a][0]} y1={GN[a][1]} x2={GN[b][0]} y2={GN[b][1]} />
          ))}
          {GN.map(([cx, cy, r], i) => (
            <circle key={i} className="vl-graph-node" cx={cx} cy={cy} r={r}
              opacity={0.18 + (i % 4) * 0.06} />
          ))}
        </svg>
      ) : (
        <>
          <div className="vl-wb-grid" />
          <div className="vl-wb-shape" style={{ width: 180, height: 80,  top: "18%",    left:  "12%", animationDelay: "0s"   }} />
          <div className="vl-wb-shape" style={{ width: 140, height: 140, top: "20%",    right: "15%", borderRadius: "50%", animationDelay: "0.6s" }} />
          <div className="vl-wb-shape" style={{ width: 220, height: 70,  bottom: "22%", left:  "22%", animationDelay: "1.1s" }} />
          <div className="vl-wb-shape" style={{ width: 100, height: 100, bottom: "25%", right: "20%", animationDelay: "0.3s" }} />
        </>
      )}

      {/* Centre badge + spinner + label */}
      <div className="vl-center">
        <div className="vl-badge">
          {isGraph ? <Network size={24} strokeWidth={1.6} /> : <PenTool size={24} strokeWidth={1.6} />}
        </div>
        <div className="vl-spinner" />
        <span className="vl-label">
          {isGraph ? "Loading Knowledge Graph" : "Loading Whiteboard"}
        </span>
      </div>

    </div>
  );
}
