import type { StorageQuota } from "./vaultSync";

/** Share of the limit (percent) from which the storage bar warns. */
export const STORAGE_WARNING_PERCENT = 85;
export const STORAGE_CRITICAL_PERCENT = 95;

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** "15 GB" / "1.2 GB" / "340 KB". Binary units, as Google shows them (15 GB = 15 × 1024³). */
export function formatStorage(bytes: number): string {
  let n = Math.max(0, bytes);
  let u = 0;
  // 1023.95 would print as "1024.0", so it moves up a unit.
  while (n >= 1023.95 && u < UNITS.length - 1) {
    n /= 1024;
    u++;
  }
  return `${Number(n.toFixed(u === 0 ? 0 : 1))} ${UNITS[u]}`;
}

export type StorageLevel = "ok" | "warning" | "critical" | "full";

export interface StorageView {
  summary: string;
  free: string;
  /** null = no limit, so there's no bar. */
  percent: number | null;
  level: StorageLevel;
}

export function describeStorage({ limit, usage }: StorageQuota): StorageView {
  if (limit == null) {
    return { summary: `${formatStorage(usage)} used`, free: "No storage limit", percent: null, level: "ok" };
  }
  const full = usage >= limit;
  const ratio = full ? 100 : (usage / limit) * 100;
  const level: StorageLevel = full ? "full"
    : ratio >= STORAGE_CRITICAL_PERCENT ? "critical"
    : ratio >= STORAGE_WARNING_PERCENT ? "warning"
    : "ok";
  // Rounded down, so it never reads 100% while space is left.
  const percent = Math.floor(ratio);
  const shown = percent === 0 && usage > 0 ? "less than 1%" : `${percent}%`;
  return {
    summary: `${formatStorage(usage)} of ${formatStorage(limit)} used (${shown})`,
    free: `${formatStorage(Math.max(0, limit - usage))} free`,
    percent,
    level,
  };
}
