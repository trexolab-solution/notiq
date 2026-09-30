import type { Cv } from "./graphData";

/* ── Empty state ────────────────────────────────────────────────────────── */
export function GraphEmptyState({ cv }: { cv: Cv }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 select-none"
      style={{ background: cv.bg }}>
      <div className="flex items-center justify-center w-16 h-16 rounded-2xl"
        style={{ background: `${cv.primary}18`, color: cv.primary, fontSize: 28 }}>{"◈"}</div>
      <div className="text-center max-w-xs px-4">
        <p className="text-sm font-semibold mb-2" style={{ color: cv.text }}>No connections yet</p>
        <p className="text-xs leading-5" style={{ color: cv.muted }}>
          Link notes with markdown:{" "}
          <code className="px-1.5 py-0.5 rounded font-mono text-xs"
            style={{ background: cv.bgSec, color: cv.primary, border: `1px solid ${cv.border}` }}>
            [[Note Title]]
          </code>
        </p>
      </div>
    </div>
  );
}
