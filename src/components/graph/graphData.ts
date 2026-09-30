import type { GraphLink, GraphNode } from "../../types";

/* ── Theme colours ──────────────────────────────────────────────────────── */
export type Cv = {
  primary: string; text: string; muted: string;
  bg: string; bgSec: string; border: string; isLight: boolean;
};
export function luminance(hex: string): number {
  const c = hex.replace("#", "").padEnd(6, "0");
  return 0.2126 * (parseInt(c.slice(0, 2), 16) / 255) +
         0.7152 * (parseInt(c.slice(2, 4), 16) / 255) +
         0.0722 * (parseInt(c.slice(4, 6), 16) / 255);
}
export function getCv(): Cv {
  const s = getComputedStyle(document.documentElement);
  const g = (v: string) => s.getPropertyValue(v).trim() || undefined;
  const bg = g("--color-bg") ?? "#0a0e1a";
  return {
    primary: g("--color-primary") ?? "#c9a84c",
    text: g("--color-text") ?? "#e2e8f0", muted: g("--color-text-muted") ?? "#94a3b8",
    bg, bgSec: g("--color-bg-secondary") ?? "#1e293b", border: g("--color-border") ?? "#334155",
    isLight: luminance(bg) > 0.45,
  };
}

/* ── Colour helpers ─────────────────────────────────────────────────────── */
export function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
export function nodeColor(id: string, isLight: boolean): string {
  const sum = Array.from(id).reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = (sum * 137.508) % 360;
  return isLight ? hslToHex(hue, 50, 45) : hslToHex(hue, 45, 60);
}
export function truncate(s: string, max = 22) { return s.length > max ? s.slice(0, max - 1) + "…" : s; }
export function degreeMap(nodes: GraphNode[], links: GraphLink[]): Record<string, number> {
  const d: Record<string, number> = {};
  nodes.forEach(n => (d[n.id] = 0));
  links.forEach(l => { d[l.source] = (d[l.source] || 0) + 1; d[l.target] = (d[l.target] || 0) + 1; });
  return d;
}
export function nodeRadius(degree: number) { return 2 + Math.sqrt(Math.max(0, degree)) * 1.2; }

/* ── Force-graph node shape at runtime ─────────────────────────────────── */
export interface FgNode {
  id: string;
  name: string;
  tabId?: string;
  degree: number;
  val: number;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
}

/* ── Link endpoint helpers ──────────────────────────────────────────────── */
export type LinkEndpoint = string | { id?: string };
export type LinkObj = { source: LinkEndpoint; target: LinkEndpoint };
export function rid(ep: LinkEndpoint): string { return typeof ep === "object" ? (ep?.id ?? "") : (ep ?? ""); }
