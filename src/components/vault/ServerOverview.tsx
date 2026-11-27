import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Activity, Cpu, HardDrive, MemoryStick, PlugZap, RefreshCw, ServerOff, TriangleAlert, Unplug } from "lucide-react";
import { Button } from "../ui/Button";
import { Section } from "./EntryParts";
import { useDock } from "./DockedPanel";
import { ServerDetailsButton } from "./ServerDetailsButton";
import { TrustHost } from "../remote/panel/ConnectionStatus";
import { newSessionId } from "../remote/panel/types";
import { SshAuthChoiceDialog } from "../terminal/SshAuthChoiceDialog";
import { useAppStore } from "../../store";
import { useVaultStore } from "../../store/vaultStore";
import { parseUnknownHost, sftpErrorMessage, type UnknownHost } from "../../lib/sftp";
import { sshLabel, sshMethods } from "../../lib/sshConnect";
import { getLastSshAuth } from "../../lib/sshLastAuth";
import type { SshAuth } from "../../lib/sshEntry";
import type { AuthPreference } from "../../lib/sshPreferredAuth";
import {
  describeHistory, formatBytes, HISTORY, OVERVIEW_BUSY, overviewClose, overviewOpen, overviewPoll, percentOf,
  pushHistory, usageTone, type ServerDisk, type ServerReading,
} from "../../lib/serverOverview";
import type { Tab } from "../../types";

/** Time between readings, and before the second one (the first can't measure CPU use yet). */
export const POLL_MS = 3000;
export const FIRST_POLL_MS = 1000;
/** How long the panel has to stay in view before it connects by itself (flipping through tabs opens nothing). */
export const AUTO_DELAY_MS = 600;

/**
 * Entries that are not to be connected again without a click: the sign-in or the reading failed (trying over and over
 * can get the address blocked by the server), or the user pressed Disconnect. For this run of the app.
 */
const heldPaths = new Set<string>();
export const clearHeldOverviews = (): void => heldPaths.clear();

type Phase =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "trust"; host: UnknownHost; auth: SshAuth }
  | { kind: "live" }
  | { kind: "stopped"; why: string }
  | { kind: "failed"; message: string }
  | { kind: "unsupported"; system: string };

const TONE_BAR = { ok: "var(--color-primary)", warn: "var(--color-warning)", bad: "var(--color-danger)" } as const;

/** Whether the form section holding `ref` is the one shown, and the window is not minimised or in the background. */
function usePanelShown(ref: React.RefObject<HTMLElement | null>, at: HTMLElement | null): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const panel = ref.current?.closest<HTMLElement>("[data-panel]") ?? null;
    const read = () => setShown(!panel?.hidden && document.visibilityState !== "hidden");
    read();
    const watch = panel && typeof MutationObserver !== "undefined" ? new MutationObserver(read) : null;
    if (panel) watch?.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    document.addEventListener("visibilitychange", read);
    return () => { watch?.disconnect(); document.removeEventListener("visibilitychange", read); };
    // `at`: moved between the sections and the right column, it sits in another section (or none).
  }, [ref, at]);
  return shown;
}

// ── graphs ──────────────────────────────────────────────────────────────────

/** An area graph of percentages (0–100), newest on the right; the axis is fixed so a quiet server looks quiet. */
function Sparkline({ values, label, color }: { values: readonly number[]; label: string; color: string }) {
  const W = 240;
  const H = 56;
  if (values.length < 2) {
    return (
      <div role="img" aria-label={describeHistory(label, values)}
           className="h-11 rounded-md border border-dashed border-[var(--color-border)] flex items-center justify-center text-[11px] text-[var(--color-text-muted)]">
        Collecting readings…
      </div>
    );
  }
  const step = W / (HISTORY - 1);
  const x = (i: number) => W - (values.length - 1 - i) * step;
  const y = (v: number) => H - 1 - (v / 100) * (H - 2);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${x(values.length - 1).toFixed(1)},${H}L${x(0).toFixed(1)},${H}Z`;
  return (
    <svg role="img" aria-label={describeHistory(label, values)} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
         className="block w-full h-11 rounded-md bg-[var(--color-bg-tertiary)]/40" data-sparkline="">
      {[25, 50, 75].map((g) => (
        <line key={g} x1={0} x2={W} y1={y(g)} y2={y(g)} stroke="var(--color-border)" strokeWidth={1}
              strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      ))}
      <path d={area} fill={color} fillOpacity={0.16} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A horizontal bar with its value for assistive technology; `parts` are drawn left to right. */
function UsageBar({ label, pct, text, parts }: { label: string; pct: number; text: string; parts: { pct: number; color: string; faint?: boolean }[] }) {
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-valuetext={text}
         className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
      {parts.map((p, i) => (
        <div key={i} className="h-full transition-[width] duration-500 motion-reduce:transition-none"
             style={{ width: `${Math.max(0, Math.min(100, p.pct))}%`, background: p.color, opacity: p.faint ? 0.35 : 1 }} />
      ))}
    </div>
  );
}

function Card({ icon: Icon, title, value, sub, children }: {
  icon: typeof Cpu; title: string; value: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={14} aria-hidden className="shrink-0 text-[var(--color-text-muted)]" />
          <h3 className="flex-1 min-w-0 truncate text-xs font-medium text-[var(--color-text-muted)]">{title}</h3>
          <p className="shrink-0 text-base font-semibold leading-tight tabular-nums">{value}</p>
        </div>
        {sub && <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)] tabular-nums truncate">{sub}</p>}
      </div>
      {children}
    </div>
  );
}

function DiskRow({ disk }: { disk: ServerDisk }) {
  const pct = percentOf(disk.used, disk.total);
  const tone = usageTone(pct);
  const text = `${formatBytes(disk.used)} of ${formatBytes(disk.total)} used, ${formatBytes(disk.available)} free`;
  const meta = [disk.fsType, disk.device].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-col gap-1.5 min-w-0" data-disk={disk.mount}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
        <span className="font-mono text-[13px] truncate max-w-full" title={disk.mount}>{disk.mount}</span>
        {meta && <span className="flex-1 min-w-[6rem] text-[11px] text-[var(--color-text-muted)] truncate" title={meta}>{meta}</span>}
        <span className="ml-auto shrink-0 text-xs tabular-nums">
          <span className="font-medium" style={tone === "ok" ? undefined : { color: TONE_BAR[tone] }}>{Math.round(pct)}%</span>
          <span className="text-[var(--color-text-muted)]"> · {formatBytes(disk.used)} of {formatBytes(disk.total)}</span>
        </span>
      </div>
      <UsageBar label={`Disk ${disk.mount}`} pct={pct} text={text} parts={[{ pct, color: TONE_BAR[tone] }]} />
    </li>
  );
}

/** Everything a reading says, laid out as cards; `stale` dims it (the connection is closed). */
function Dashboard({ r, cpu, mem, stale }: { r: ServerReading; cpu: number[]; mem: number[]; stale: boolean }) {
  const m = r.memory;
  const memPct = m ? percentOf(m.used, m.total) : 0;
  const cachePct = m ? percentOf(Math.min(m.cached, m.available), m.total) : 0;
  const cpuNow = r.cpuPercent;
  const load = r.load ? r.load.map((v) => v.toFixed(2)).join("  ") : null;
  const swapPct = r.swap ? percentOf(r.swap.used, r.swap.total) : 0;
  return (
    <div className={`flex flex-col gap-3 transition-opacity motion-reduce:transition-none ${stale ? "opacity-60" : ""}`} data-overview="">
      <div className="grid grid-cols-1 @md:grid-cols-2 gap-3">
        <Card icon={Cpu} title="CPU" value={cpuNow === null ? "Measuring…" : `${Math.round(cpuNow)}%`}
              sub={[r.cores ? `${r.cores} core${r.cores === 1 ? "" : "s"}` : null, load ? `load ${load}` : null].filter(Boolean).join(" · ") || undefined}>
          <Sparkline values={cpu} label="CPU usage" color="var(--color-primary)" />
          {load && <p className="sr-only">Load average over 1, 5 and 15 minutes: {r.load!.map((v) => v.toFixed(2)).join(", ")}</p>}
        </Card>
        <Card icon={MemoryStick} title="Memory" value={m ? `${Math.round(memPct)}%` : "–"}
              sub={m ? `${formatBytes(m.used)} of ${formatBytes(m.total)} in use` : "Not reported"}>
          <Sparkline values={mem} label="Memory usage" color="var(--color-accent)" />
          {m && (
            <div className="flex flex-col gap-1.5">
              <UsageBar label="Memory" pct={memPct}
                        text={`${formatBytes(m.used)} used, ${formatBytes(m.cached)} cache, ${formatBytes(m.available)} available of ${formatBytes(m.total)}`}
                        parts={[{ pct: memPct, color: "var(--color-accent)" }, { pct: cachePct, color: "var(--color-accent)", faint: true }]} />
              <p className="flex flex-wrap gap-x-3 text-[11px] text-[var(--color-text-muted)] tabular-nums">
                <span>Cache {formatBytes(m.cached)}</span><span>Available {formatBytes(m.available)}</span>
              </p>
            </div>
          )}
          {r.swap && (
            <div className="flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-2">
              <div className="flex items-baseline gap-2 text-xs">
                <span className="text-[var(--color-text-muted)]">Swap</span>
                <span className="ml-auto tabular-nums">{r.swap.total ? `${formatBytes(r.swap.used)} of ${formatBytes(r.swap.total)}` : "None"}</span>
              </div>
              {r.swap.total > 0 && (
                <UsageBar label="Swap" pct={swapPct} text={`${formatBytes(r.swap.used)} of ${formatBytes(r.swap.total)} used`}
                          parts={[{ pct: swapPct, color: TONE_BAR[usageTone(swapPct)] }]} />
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="flex flex-col gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <h3 className="flex items-center gap-2 text-xs font-medium text-[var(--color-text-muted)]">
          <HardDrive size={15} aria-hidden /> Disks
        </h3>
        {r.disks.length ? (
          <ul className="flex flex-col gap-2.5" aria-label="Disk usage">
            {r.disks.map((d, i) => <DiskRow key={`${d.mount}-${i}`} disk={d} />)}
          </ul>
        ) : <p className="text-xs text-[var(--color-text-muted)]">The server reported no disks.</p>}
        {r.disksMore > 0 && <p className="text-[11px] text-[var(--color-text-muted)]">And {r.disksMore} more not shown.</p>}
      </div>
    </div>
  );
}

const BONE = "rounded bg-[var(--color-bg-tertiary)] motion-safe:animate-pulse";
const Bone = ({ className }: { className: string }) => <div className={`${BONE} ${className}`} />;

function SkeletonCard({ bar }: { bar?: boolean }) {
  return (
    <div className="flex flex-col gap-2 min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
      <div className="flex items-center gap-2"><Bone className="h-3.5 w-3.5 shrink-0" /><Bone className="h-3 w-16" /><Bone className="ml-auto h-4 w-10" /></div>
      <Bone className="h-2.5 w-3/4" />
      <Bone className="h-11 w-full" />
      {bar && <Bone className="h-2 w-full !rounded-full" />}
    </div>
  );
}

/** Shown until the first reading: the same cards as the dashboard, as shapes, so nothing jumps when it arrives. */
function Skeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden data-overview-skeleton="">
      <div className="grid grid-cols-1 @md:grid-cols-2 gap-3"><SkeletonCard /><SkeletonCard bar /></div>
      <div className="flex flex-col gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <Bone className="h-3 w-14" />
        {[0, 1].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="flex justify-between gap-3"><Bone className="h-3 w-20" /><Bone className="h-3 w-28" /></div>
            <Bone className="h-2 w-full !rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * "Server overview" section of a saved SSH entry: CPU, memory, swap and disks with graphs; the basics are behind the
 * "i" button. Once in view it connects by itself with the only saved sign-in method, the preferred one or the one last
 * used; after a failure or Disconnect it waits for a click. An unknown host key is never accepted without the user.
 * It reads the server only while shown in the active tab, one reading at a time, and closes the connection when
 * hidden, when the entry changes or closes, and when the vault locks.
 */
export function ServerOverview({ tab, name, fields, pref }: { tab: Tab; name: string; fields: Record<string, string>; pref: AuthPreference }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { place, at } = useDock();
  const shown = usePanelShown(rootRef, at);
  const active = useAppStore((s) => s.activeTabId === tab.id);
  const unlocked = useVaultStore((s) => s.unlocked) && !tab.vaultLocked;
  const visible = shown && active;
  const methods = sshMethods(fields);
  const blocked = !tab.filePath ? "Save this entry first."
    : !unlocked ? "Unlock the vault first."
    : tab.isDirty ? "Save this entry first (Ctrl+S); the overview uses the saved version."
    : !fields.host?.trim() || !fields.username?.trim() ? "Add a host and a username first."
    : !methods.length ? "Save a password or a private key first." : null;

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [reading, setReading] = useState<ServerReading | null>(null);
  const [cpu, setCpu] = useState<number[]>([]);
  const [mem, setMem] = useState<number[]>([]);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [choosing, setChoosing] = useState(false);
  /** About to connect by itself. */
  const [pending, setPending] = useState(false);

  const sid = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const pathRef = useRef(tab.filePath);
  pathRef.current = tab.filePath;

  /** Stops reading and closes the connection (nothing to do when there is none). */
  const stop = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const s = sid.current;
    sid.current = 0;
    if (s) void overviewClose(s).catch(() => {});
    return s !== 0;
  }, []);

  const poll = useCallback(async () => {
    const id = sid.current;
    if (!id || inFlight.current) return;
    inFlight.current = true;
    let next: number | null = POLL_MS;
    try {
      const r = await overviewPoll(id);
      if (sid.current !== id) { next = null; return; }
      if (!r.supported) {
        next = null;
        stop();
        heldPaths.add(pathRef.current ?? "");
        setReading(null);
        setPhase({ kind: "unsupported", system: r.system });
        return;
      }
      setReading(r);
      setUpdated(new Date());
      setCpu((h) => pushHistory(h, r.cpuPercent));
      if (r.memory) setMem((h) => pushHistory(h, percentOf(r.memory!.used, r.memory!.total)));
      if (r.cpuPercent === null) next = FIRST_POLL_MS;
    } catch (e) {
      if (sid.current !== id) { next = null; return; }
      const m = sftpErrorMessage(e);
      if (m !== OVERVIEW_BUSY) { next = null; stop(); heldPaths.add(pathRef.current ?? ""); setPhase({ kind: "failed", message: m }); }
    } finally {
      inFlight.current = false;
      if (next !== null && sid.current === id) timer.current = setTimeout(() => { void poll(); }, next);
    }
  }, [stop]);

  const connect = useCallback(async (auth: SshAuth, trust: UnknownHost | null = null) => {
    const path = pathRef.current;
    if (!path) return;
    stop();
    const id = newSessionId();
    sid.current = id;
    setPhase({ kind: "connecting" });
    try {
      await overviewOpen(id, path, auth, trust);
      if (sid.current !== id) { void overviewClose(id).catch(() => {}); return; }
      heldPaths.delete(path);
      setPhase({ kind: "live" });
      void poll();
    } catch (e) {
      if (sid.current !== id) return;
      sid.current = 0;
      const m = sftpErrorMessage(e);
      const host = parseUnknownHost(m);
      heldPaths.add(path);
      setPhase(host ? { kind: "trust", host, auth } : { kind: "failed", message: m });
    }
  }, [poll, stop]);

  // A change to the entry (a new password, another host) is a reason to try again.
  useEffect(() => { if (tab.isDirty && tab.filePath) heldPaths.delete(tab.filePath); }, [tab.isDirty, tab.filePath]);

  const start = () => {
    if (blocked || !visible) return;
    if (methods.length === 1) void connect(methods[0]);
    else if (pref !== "ask") void connect(pref);
    else setChoosing(true);
  };

  // Hidden (another section, another tab, window in the background) or the entry changed: stop and close.
  const canRun = visible && !blocked;
  useEffect(() => {
    if (canRun) return;
    if (stop()) {
      setPhase({ kind: "stopped", why: !visible ? "Paused while this section wasn't shown." : blocked ?? "Stopped." });
    }
    setChoosing(false);
  }, [canRun, visible, blocked, stop]);

  // Hidden to the tray: the page isn't always told it is hidden, so the app's own event stops it too.
  const inTray = useRef(false);
  const [wake, setWake] = useState(0);
  useEffect(() => {
    const back = () => { if (inTray.current) { inTray.current = false; setWake((n) => n + 1); } };
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, []);
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    listen("vault-window-hidden", () => {
      inTray.current = true;
      setPending(false);
      if (!stop()) return;
      setPhase({ kind: "stopped", why: "Disconnected when Notiq was hidden." });
    }).then((un) => { if (gone) un(); else off = un; }).catch(() => {});
    return () => { gone = true; off?.(); };
  }, [stop]);

  // The vault locked: close, and forget what was read.
  useEffect(() => {
    if (unlocked) return;
    stop();
    setReading(null); setCpu([]); setMem([]); setUpdated(null);
    setPhase({ kind: "idle" });
  }, [unlocked, stop]);

  // The entry was renamed or moved: close, and start over for the new one.
  const shownPath = useRef(tab.filePath);
  useEffect(() => {
    if (tab.filePath === shownPath.current) return;
    shownPath.current = tab.filePath;
    stop();
    setReading(null); setCpu([]); setMem([]); setUpdated(null);
    setPhase({ kind: "idle" });
  }, [tab.filePath, stop]);
  // The tab closed (or the editor went away): close the connection.
  useEffect(() => () => { stop(); }, [stop]);

  // Connect by itself when it comes into view (with two methods saved and none used yet, the first Connect asks).
  // Declared after the effects that close and reset.
  const lastUsed = getLastSshAuth(tab.filePath);
  const autoAuth: SshAuth | null = methods.length === 1 ? methods[0]
    : pref !== "ask" && methods.includes(pref) ? pref
    : lastUsed && methods.includes(lastUsed) ? lastUsed : null;
  const autoRef = useRef(autoAuth);
  autoRef.current = autoAuth;
  useEffect(() => {
    const path = pathRef.current;
    if (!canRun || !path || !autoRef.current || inTray.current || sid.current || heldPaths.has(path)) return;
    setPending(true);
    const t = setTimeout(() => {
      setPending(false);
      const auth = autoRef.current;
      if (auth && !inTray.current && !sid.current && !heldPaths.has(path)) void connect(auth);
    }, AUTO_DELAY_MS);
    return () => { clearTimeout(t); setPending(false); };
  }, [canRun, tab.filePath, wake, connect]);

  const live = phase.kind === "live";
  const connecting = phase.kind === "connecting" || pending;
  /** Nothing to show yet, but a reading is on its way. */
  const loading = !reading && (connecting || live);
  const label = sshLabel(fields) || "this server";
  const status = live ? (updated ? `Live · updated ${updated.toLocaleTimeString()}` : "Live")
    : connecting ? "Connecting…" : phase.kind === "stopped" ? "Disconnected" : null;
  /** Said once per change of state (not on every reading). */
  const announce = live ? `Connected to ${label}` : connecting ? `Connecting to ${label}` : phase.kind === "stopped" ? "Disconnected" : "";

  const aside = (
    <div className="flex items-center gap-2 shrink-0">
      <span role="status" className="sr-only" data-overview-announce="">{announce}</span>
      {status && (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)] tabular-nums" data-overview-status="">
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${live ? "bg-[var(--color-success)] motion-safe:animate-pulse" : "bg-[var(--color-text-muted)]"}`} />
          {status}
        </span>
      )}
      {reading && visible && <ServerDetailsButton reading={reading} />}
      {live || phase.kind === "connecting" ? (
        <Button size="sm" icon={<Unplug size={12} />} onClick={() => { stop(); heldPaths.add(tab.filePath ?? ""); setPhase({ kind: "stopped", why: "Disconnected." }); }}
                className="border border-[var(--color-border)]">
          Disconnect
        </Button>
      ) : !pending && (reading || phase.kind === "failed" || phase.kind === "unsupported") ? (
        <Button size="sm" icon={<RefreshCw size={12} />} disabled={!!blocked} title={blocked ?? undefined} onClick={start}
                className="border border-[var(--color-border)]">
          {phase.kind === "failed" ? "Try again" : "Connect"}
        </Button>
      ) : null}
    </div>
  );

  let body: React.ReactNode;
  if (phase.kind === "trust") {
    body = <TrustHost host={phase.host} onTrust={() => { void connect(phase.auth, phase.host); }}
                      onDecline={() => setPhase({ kind: "failed", message: "You didn't trust this server's key, so nothing was sent to it." })} />;
  } else if (phase.kind === "unsupported") {
    body = (
      <div className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] p-4" role="status" data-overview-unsupported="">
        <ServerOff size={18} aria-hidden className="shrink-0 text-[var(--color-text-muted)]" />
        <div className="min-w-0 text-sm">
          <p className="font-medium">This server isn't supported</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)] break-words">
            The overview reads Linux servers only{phase.system ? `; this one reports “${phase.system}”` : "; this one didn't answer like one"}. Nothing is shown rather than numbers that could be wrong.
          </p>
        </div>
      </div>
    );
  } else if (phase.kind === "failed" && !reading) {
    body = (
      <div className="flex items-start gap-3 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 p-4" role="alert">
        <TriangleAlert size={18} aria-hidden className="shrink-0 text-[var(--color-danger)]" />
        <div className="min-w-0 text-sm">
          <p className="font-medium">Couldn't read this server</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)] whitespace-pre-wrap break-words">{phase.message}</p>
        </div>
      </div>
    );
  } else if (reading) {
    const note = phase.kind === "stopped" ? phase.why : phase.kind === "failed" ? phase.message : null;
    body = (<>
      {note && (
        <p className={`flex items-start gap-2 text-xs ${phase.kind === "failed" ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`}
           role={phase.kind === "failed" ? "alert" : undefined}>
          {phase.kind === "failed" ? <TriangleAlert size={13} aria-hidden className="mt-px shrink-0" /> : <Unplug size={13} aria-hidden className="mt-px shrink-0" />}
          <span className="min-w-0 break-words">{note} The last reading is shown.</span>
        </p>
      )}
      <Dashboard r={reading} cpu={cpu} mem={mem} stale={!live} />
    </>);
  } else if (loading) {
    body = <Skeleton />;
  } else {
    body = (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] px-4 py-8 text-center" data-overview-idle="">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-bg-tertiary)]">
          <Activity size={18} aria-hidden className="text-[var(--color-primary)]" />
        </span>
        <div className="flex flex-col gap-1 max-w-sm">
          <p className="text-sm font-medium">See how {label} is doing</p>
          <p className="text-xs text-[var(--color-text-muted)]">
            CPU, memory and disk usage with live graphs. Notiq signs in with this entry and only reads; nothing on the server is changed. Linux servers.
          </p>
        </div>
        {phase.kind === "stopped" && <p className="text-xs text-[var(--color-text-muted)]">{phase.why}</p>}
        <Button variant="primary" icon={<PlugZap size={14} />} disabled={!!blocked} onClick={start} aria-describedby={blocked ? "overview-blocked" : undefined}>
          Connect
        </Button>
        {blocked && <p id="overview-blocked" className="text-xs text-[var(--color-text-muted)]">{blocked}</p>}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="contents">
      <Section title="Server overview" aside={aside}
               hint={place === "side" ? undefined : "Read over SSH while this section is open; it disconnects when you leave it."}>
        {body}
      </Section>
      {choosing && (
        <SshAuthChoiceDialog
          name={name || "this server"}
          label={sshLabel(fields)}
          entryKey={tab.filePath}
          onPick={(m) => { setChoosing(false); void connect(m); }}
          onClose={() => setChoosing(false)}
        />
      )}
    </div>
  );
}
