import { invoke } from "@tauri-apps/api/core";
import type { UnknownHost } from "./sftp";

/**
 * Server overview in the SSH entry form: wrappers over the backend's `server_overview_*` commands
 * (server_overview.rs) and the pure helpers the panel shows its numbers with. The backend signs in with the saved
 * entry itself (the web view only sends the entry's path and the sign-in method) and runs one fixed, read-only
 * command; every string in a reading comes from the server and is shown as plain text only.
 */

export interface ServerMemory { total: number; used: number; available: number; cached: number }
export interface ServerSwap { total: number; used: number }
export interface ServerDisk { mount: string; device: string; fsType: string; total: number; used: number; available: number }

export interface ServerReading {
  /** False for anything but Linux: only `system` and `hostname` are filled in then. */
  supported: boolean;
  system: string;
  hostname: string | null;
  os: string | null;
  kernel: string | null;
  arch: string | null;
  cpuModel: string | null;
  uptimeSecs: number | null;
  cores: number | null;
  /** Busy share of all CPUs since the previous reading (none on the first). */
  cpuPercent: number | null;
  load: [number, number, number] | null;
  memory: ServerMemory | null;
  swap: ServerSwap | null;
  disks: ServerDisk[];
  disksMore: number;
}

/** What a poll says while the previous one is still running. */
export const OVERVIEW_BUSY = "busy";

/** `trust` is the key the user just approved; the backend accepts only an exact match, and never a changed key. */
export const overviewOpen = (id: number, path: string, auth: string, trust: UnknownHost | null = null) =>
  invoke<void>("server_overview_open", { id, path, auth, trust });
export const overviewPoll = (id: number) => invoke<ServerReading>("server_overview_poll", { id });
export const overviewClose = (id: number) => invoke<void>("server_overview_close", { id });

/** Readings kept for the graphs (one every few seconds: a few minutes of history). */
export const HISTORY = 60;

/** `list` with `value` added at the end, at most `HISTORY` long. */
export function pushHistory(list: readonly number[], value: number | null): number[] {
  if (value === null || !Number.isFinite(value)) return [...list];
  const next = [...list, Math.min(100, Math.max(0, value))];
  return next.length > HISTORY ? next.slice(next.length - HISTORY) : next;
}

/** `part` of `whole` as a percentage from 0 to 100 (0 when `whole` is 0). */
export function percentOf(part: number, whole: number): number {
  if (!(whole > 0) || !Number.isFinite(part)) return 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

/** Bytes for people, in powers of 1024 like `df -h` and `free -h`: `1.5 GB`, `512 MB`. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "–";
  const units = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = i === 0 ? 0 : v < 10 ? 1 : 0;
  return `${v.toFixed(digits)} ${units[i]}`;
}

/** `3 days, 4 hours` / `2 hours, 5 minutes` / `12 minutes`. */
export function formatUptime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "–";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (d > 0) return h > 0 ? `${part(d, "day")}, ${part(h, "hour")}` : part(d, "day");
  if (h > 0) return m > 0 ? `${part(h, "hour")}, ${part(m, "minute")}` : part(h, "hour");
  return part(m, "minute");
}

/** How full a bar is, as a tone: past 90 % it is a problem, past 75 % a warning. */
export function usageTone(pct: number): "ok" | "warn" | "bad" {
  return pct >= 90 ? "bad" : pct >= 75 ? "warn" : "ok";
}

/** One sentence for a graph, for screen readers: lowest, highest and latest of the readings. */
export function describeHistory(what: string, values: readonly number[]): string {
  if (!values.length) return `${what}: no readings yet`;
  const r = (v: number) => `${Math.round(v)}%`;
  const now = values[values.length - 1];
  if (values.length === 1) return `${what}: ${r(now)}`;
  return `${what} over the last ${values.length} readings: now ${r(now)}, lowest ${r(Math.min(...values))}, highest ${r(Math.max(...values))}`;
}
