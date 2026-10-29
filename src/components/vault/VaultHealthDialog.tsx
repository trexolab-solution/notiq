import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../ui/Button";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { useVaultStore } from "../../store/vaultStore";
import { vaultErrorMessage } from "../../lib/vault";
import {
  analyzeHealth, HEALTH_ISSUES, itemsWithIssue, OLD_AFTER_DAYS, readAllLogins, type HealthIssue, type HealthReport,
} from "../../lib/vaultHealth";
import { openEntry } from "./sidebar/actions";

const ISSUE_LABEL: Record<HealthIssue, string> = {
  weak: "Weak", reused: "Reused", old: "Old", empty: "Empty", http: "Not HTTPS",
};
const ISSUE_HINT: Record<HealthIssue, string> = {
  weak: "Short, common or easy to guess",
  reused: "Same password on more than one login",
  old: `Not changed for over ${OLD_AFTER_DAYS} days`,
  empty: "No password saved",
  http: "Site address starts with http://",
};

const scoreColor = (s: number) => (s >= 80 ? "var(--color-success, #3fb950)" : s >= 50 ? "var(--color-warning, #d29922)" : "var(--color-danger)");

/** Password health for every Login entry, checked on this device only. */
export function VaultHealthDialog({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [root, setRoot] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<HealthIssue | null>(null);
  const run = useRef(0);

  const check = useCallback(async () => {
    const my = ++run.current;
    setError(null); setProgress({ done: 0, total: 0 });
    try {
      const isUnlocked = () => useVaultStore.getState().unlocked && my === run.current;
      const { root: r, logins } = await readAllLogins(isUnlocked, (done, total) => {
        if (my === run.current) setProgress({ done, total });
      });
      const rep = await analyzeHealth(logins);
      if (my !== run.current) return;
      setRoot(r); setReport(rep);
    } catch (e) {
      if (my === run.current) setError(vaultErrorMessage(e));
    } finally {
      if (my === run.current) setProgress(null);
    }
  }, []);

  useEffect(() => { void check(); return () => { run.current++; }; }, [check]);

  // Locking the vault drops the report.
  const unlocked = useVaultStore((s) => s.unlocked);
  useEffect(() => { if (!unlocked) onClose(); }, [unlocked, onClose]);

  const list = useMemo(() => (report ? itemsWithIssue(report, filter) : []), [report, filter]);
  const issueTotal = report ? report.items.filter((i) => i.issues.length).length : 0;

  return (
    <Dialog onClose={onClose} zClassName="z-[70]" size="lg" title="Vault health" icon="shield"
            headerActions={
              <Button size="sm" icon={<RefreshCw size={13} className={progress ? "animate-spin" : ""} />}
                      disabled={!!progress} onClick={() => void check()}>Re-check</Button>
            }>
      <DialogBody fill detail="Checked on this device only. Nothing is sent anywhere, and passwords are never shown here.">
          {error && <div role="alert" className="text-xs text-[var(--color-danger)]">{error}</div>}
          {progress && (
            <div className="text-xs text-[var(--color-text-muted)]" aria-live="polite">
              Checking logins{progress.total ? ` (${progress.done} of ${progress.total})` : ""}…
            </div>
          )}
          {report && (
            <>
              <div className="flex items-center gap-3">
                <div className="text-3xl font-semibold tabular-nums" style={{ color: scoreColor(report.score) }}>{report.score}</div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  Health score out of 100 · {report.total} login{report.total === 1 ? "" : "s"} checked
                  {issueTotal ? ` · ${issueTotal} need attention` : " · no problems found"}
                </div>
              </div>
              <div className="grid grid-cols-5 gap-2">
                {HEALTH_ISSUES.map((k) => {
                  const active = filter === k;
                  return (
                    <button key={k} type="button" aria-pressed={active} title={ISSUE_HINT[k]}
                            onClick={() => setFilter(active ? null : k)}
                            className={`rounded-lg border px-2 py-2 text-left transition-colors ${active
                              ? "border-[var(--color-primary)] bg-[var(--color-bg-tertiary)]"
                              : "border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)]"}`}>
                      <div className={`text-lg font-semibold tabular-nums ${report.counts[k] ? "" : "text-[var(--color-text-muted)]"}`}>
                        {report.counts[k]}
                      </div>
                      <div className="text-[11px] text-[var(--color-text-muted)]">{ISSUE_LABEL[k]}</div>
                    </button>
                  );
                })}
              </div>
              <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-[var(--color-border)]">
                {list.length === 0 ? (
                  <div className="p-4 text-xs text-center text-[var(--color-text-muted)]">
                    {filter ? `No ${ISSUE_LABEL[filter].toLowerCase()} passwords.` : report.total ? "All logins look good." : "No logins in the vault yet."}
                  </div>
                ) : (
                  <ul>
                    {list.map((it) => (
                      <li key={it.rel}>
                        <button type="button" title={`Open ${it.rel}`}
                                onClick={() => { void openEntry(root, it.rel); onClose(); }}
                                className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-bg-tertiary)]">
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium truncate">{it.title}</span>
                            <span className="block truncate text-[var(--color-text-muted)]">
                              {[it.username, it.host].filter(Boolean).join(" · ") || it.rel}
                            </span>
                          </span>
                          <span className="flex flex-wrap justify-end gap-1">
                            {it.issues.map((k) => (
                              <span key={k} className="rounded px-1.5 py-0.5 text-[10px] bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]"
                                    title={ISSUE_HINT[k]}>
                                {k === "reused" ? `Reused ×${it.reusedWith + 1}` : k === "old" ? `${it.ageDays} days old` : ISSUE_LABEL[k]}
                              </span>
                            ))}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
      </DialogBody>
      <DialogFooter start={<span className="text-[11px] text-[var(--color-text-muted)]">"Old" uses the date the entry was last saved.</span>}>
        <DialogButton variant="primary" onClick={onClose}>Done</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
