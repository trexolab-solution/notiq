import { ArrowDownToLine, ArrowUpFromLine, Check, X } from "lucide-react";
import { formatBytes } from "../../lib/vaultBackup";
import { percent } from "../../lib/sftp";
import { RowIconButton } from "../vault/ListEditor";

export interface Transfer {
  id: number;
  kind: "up" | "down";
  name: string;
  done: number;
  total: number;
  state: "running" | "done" | "error" | "cancelled" | "skipped";
  error?: string;
}

const LABEL: Record<Transfer["state"], string> = {
  running: "", done: "Done", error: "Failed", cancelled: "Cancelled", skipped: "Skipped",
};

/** The uploads and downloads of this session, newest last, with a bar for the running one. */
export function RemoteTransfers({ items, onCancel, onClear }: { items: Transfer[]; onCancel: (id: number) => void; onClear: () => void }) {
  if (items.length === 0) return null;
  const finished = items.some((t) => t.state !== "running");
  return (
    <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]" aria-label="Transfers">
      <div className="flex items-center justify-between px-3 h-7 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        <span>Transfers</span>
        {finished && <button type="button" className="normal-case tracking-normal text-xs hover:text-[var(--color-text)] cursor-pointer" onClick={onClear}>Clear finished</button>}
      </div>
      <ul className="max-h-32 overflow-y-auto pb-1">
        {items.map((t) => (
          <li key={t.id} className="flex items-center gap-2 px-3 h-8 text-xs">
            <span className="text-[var(--color-text-muted)]" aria-hidden>
              {t.kind === "up" ? <ArrowUpFromLine size={13} /> : <ArrowDownToLine size={13} />}
            </span>
            <span className="truncate w-48 shrink-0" title={t.name}>{t.name}</span>
            {t.state === "running" ? (
              <>
                <div className="flex-1 h-1.5 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden" role="progressbar"
                     aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(t.done, t.total)} aria-label={`${t.name} progress`}>
                  <div className="h-full bg-[var(--color-primary)] transition-[width] duration-100" style={{ width: `${percent(t.done, t.total)}%` }} />
                </div>
                <span className="w-28 text-right tabular-nums text-[var(--color-text-muted)]">{formatBytes(t.done)} / {formatBytes(t.total)}</span>
                <RowIconButton label={`Cancel ${t.name}`} tooltip="Cancel" icon={<X size={13} />} onClick={() => onCancel(t.id)} />
              </>
            ) : (
              <span className={`flex-1 truncate flex items-center gap-1 ${t.state === "error" ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`}
                    title={t.error}>
                {t.state === "done" && <Check size={12} className="text-[var(--color-success)]" aria-hidden />}
                {LABEL[t.state]}{t.error ? ` — ${t.error}` : ""}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
