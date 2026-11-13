import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { formatBytes } from "../../lib/vaultBackup";
import { percent } from "../../lib/sftp";

export interface Transfer {
  id: number;
  kind: "up" | "down";
  name: string;
  done: number;
  total: number;
  state: "running" | "done" | "error" | "cancelled" | "skipped";
  error?: string;
}

/** How long a card of only successful transfers stays before it closes itself. */
const AUTO_CLOSE_MS = 8000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The card's headline: what is going on now, or how it all ended. */
export function summarize(items: Transfer[]): { text: string; busy: boolean; failed: number } {
  const running = items.filter((t) => t.state === "running");
  const failed = items.filter((t) => t.state === "error").length;
  if (running.length) {
    const ups = running.filter((t) => t.kind === "up").length;
    const verb = ups === running.length ? "Uploading" : ups === 0 ? "Downloading" : "Transferring";
    return { text: `${verb} ${plural(running.length, "item")}`, busy: true, failed };
  }
  const done = items.filter((t) => t.state === "done");
  if (failed) return { text: `${plural(failed, "transfer")} failed`, busy: false, failed };
  if (done.length) {
    const ups = done.filter((t) => t.kind === "up").length;
    const what = ups === done.length ? "upload" : ups === 0 ? "download" : "transfer";
    return { text: `${plural(done.length, what)} complete`, busy: false, failed };
  }
  return { text: "Nothing was transferred", busy: false, failed };
}

/** What a row says under the name. */
function detail(t: Transfer): string {
  const verb = t.kind === "up" ? "Uploading" : "Downloading";
  switch (t.state) {
    case "running": return t.total > 0 ? `${verb} · ${percent(t.done, t.total)}% · ${formatBytes(t.done)} of ${formatBytes(t.total)}` : `${verb}…`;
    case "done": return t.kind === "up" ? "Uploaded" : "Downloaded";
    case "error": return t.error || "Failed";
    case "cancelled": return "Cancelled";
    case "skipped": return "Skipped (kept the existing file)";
  }
}

/** A small circle that fills as the transfer runs; the cancel button sits in its middle on hover. */
function Ring({ pct, onCancel, label }: { pct: number; onCancel: () => void; label: string }) {
  const r = 11, c = 2 * Math.PI * r;
  return (
    <button type="button" onClick={onCancel} aria-label={label} title="Cancel"
            className="group relative grid place-items-center w-7 h-7 shrink-0 cursor-pointer rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
      <svg width="28" height="28" viewBox="0 0 28 28" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="14" cy="14" r={r} fill="none" strokeWidth="2.5" className="stroke-[var(--color-bg-tertiary)]" />
        <circle cx="14" cy="14" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" className="stroke-[var(--color-primary)] transition-[stroke-dashoffset] duration-150"
                strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <X size={12} aria-hidden className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity" />
    </button>
  );
}

/**
 * Uploads and downloads as a floating card in the corner, like Google Drive's: a headline ("Uploading 2 items",
 * "3 uploads complete"), one row per file with a progress ring, collapse, and close once nothing is running. A card of
 * only successful transfers closes by itself after a few seconds.
 */
export function RemoteTransfers({ items, onCancel, onClear }: { items: Transfer[]; onCancel: (id: number) => void; onClear: () => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const [hover, setHover] = useState(false);
  const { text, busy, failed } = summarize(items);
  const allGood = !busy && failed === 0 && items.length > 0;

  const clear = useRef(onClear);
  clear.current = onClear;
  useEffect(() => {
    if (!allGood || hover) return;
    const t = setTimeout(() => clear.current(), AUTO_CLOSE_MS);
    return () => clearTimeout(t);
  }, [allGood, hover, items]);

  // A new batch opens the card again.
  useEffect(() => { if (busy) setCollapsed(false); }, [busy, items.length]);

  if (items.length === 0) return null;

  const running = items.filter((t) => t.state === "running");
  const overall = running.length ? Math.round(running.reduce((n, t) => n + percent(t.done, t.total), 0) / running.length) : 100;

  return (
    <div className="absolute bottom-9 right-3 z-20 w-80 max-w-[calc(100%-1.5rem)] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl overflow-hidden"
         role="region" aria-label="Transfers" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="flex items-center gap-2 pl-3 pr-1 h-10 bg-[var(--color-bg-tertiary)]">
        <span className="flex-1 min-w-0 truncate text-sm font-medium" role="status">{text}</span>
        {busy && (
          <button type="button" onClick={() => running.forEach((t) => onCancel(t.id))}
                  className="text-xs px-2 h-6 rounded cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]">
            Cancel all
          </button>
        )}
        <button type="button" aria-label={collapsed ? "Show transfers" : "Hide transfers"} aria-expanded={!collapsed} onClick={() => setCollapsed((v) => !v)}
                className="grid place-items-center w-7 h-7 rounded cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]">
          {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
        {!busy && (
          <button type="button" aria-label="Close" onClick={onClear}
                  className="grid place-items-center w-7 h-7 rounded cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]">
            <X size={15} />
          </button>
        )}
      </div>
      {busy && (
        <div className="h-0.5 bg-[var(--color-bg-tertiary)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overall} aria-label="Overall progress">
          <div className="h-full bg-[var(--color-primary)] transition-[width] duration-150" style={{ width: `${overall}%` }} />
        </div>
      )}
      {!collapsed && (
        <ul className="max-h-56 overflow-y-auto py-1">
          {items.map((t) => (
            <li key={t.id} className="flex items-center gap-2.5 px-3 h-12">
              <span className="text-[var(--color-text-muted)] shrink-0" aria-hidden>
                {t.kind === "up" ? <ArrowUpFromLine size={15} /> : <ArrowDownToLine size={15} />}
              </span>
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm" title={t.name}>{t.name}</p>
                <p className={`truncate text-[11px] ${t.state === "error" ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`} title={t.error}>{detail(t)}</p>
              </div>
              {t.state === "running" && <Ring pct={percent(t.done, t.total)} label={`Cancel ${t.name}`} onCancel={() => onCancel(t.id)} />}
              {t.state === "done" && <Check size={16} className="shrink-0 text-[var(--color-success)]" aria-label="Done" />}
              {t.state === "error" && <AlertCircle size={16} className="shrink-0 text-[var(--color-danger)]" aria-label="Failed" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
