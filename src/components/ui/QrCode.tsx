import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** A QR code for `value`, drawn as one SVG path (always black on white so every camera reads it, in dark themes too). */
export function QrCode({ value, size = 168, label }: { value: string; size?: number; label: string }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { count: n, path: d };
  }, [value]);
  const box = count + 8; // 4 modules of white margin on every side
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${box} ${box}`} shapeRendering="crispEdges" className="rounded-md">
      <rect width={box} height={box} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
