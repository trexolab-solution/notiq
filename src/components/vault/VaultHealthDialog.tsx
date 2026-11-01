import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../ui/Button";
import { InlineLoading } from "../ui/Loading";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { useVaultStore } from "../../store/vaultStore";
import { vaultErrorMessage } from "../../lib/vault";
import {
  analyzeHealth, applyBreaches, HEALTH_ISSUES, itemsWithIssue, OLD_AFTER_DAYS, readAllLogins, type HealthIssue, type HealthReport,
} from "../../lib/vaultHealth";
import { BreachCheckError, checkBreaches } from "../../lib/vaultBreach";
import { getBreachCheck, setBreachCheck } from "../../lib/vaultPrefs";
import { Toggle } from "../ui/Toggle";
import { openEntry } from "./sidebar/actions";

const ISSUE_LABEL: Record<HealthIssue, string> = {
  breached: "Breached", weak: "Weak", reused: "Reused", old: "Old", empty: "Empty", http: "Not HTTPS",
};
const ISSUE_HINT: Record<HealthIssue, string> = {
  breached: "Password found in a known data breach",
  weak: "Short, common or easy to guess",
  reused: "Same password on more than one login",
  old: `Not changed for over ${OLD_AFTER_DAYS} days`,
  empty: "No password saved",
  http: "Site address starts with http://",
};

const scoreColor = (s: number) => (s >= 80 ? "var(--color-success, #3fb950)" : s >= 50 ? "var(--color-warning, #d29922)" : "var(--color-danger)");

/** Password health for every Login entry, checked on this device only. */
export function VaultHealthDialog({ onClose }: { onClose: () => void }) {
  const [base, setBase] = useState<HealthReport | null>(null);
  const [breaches, setBreaches] = useState<Map<string, number> | null>(null);
  const [breachOn, setBreachOn] = useState(getBreachCheck);
  const [breachProgress, setBreachProgress] = useState<{ done: number; total: number } | null>(null);
  const [breachError, setBreachError] = useState<string | null>(null);
  const [root, setRoot] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<HealthIssue | null>(null);
  const run = useRef(0);
  const breachOnRef = useRef(breachOn);
  breachOnRef.current = breachOn;

  const check = useCallback(async () => {
    const my = ++run.current;
    setError(null); setBreachError(null); setBreachProgress(null); setProgress({ done: 0, total: 0 });
    try {
      const isUnlocked = () => useVaultStore.getState().unlocked && my === run.current;
      const { root: r, logins } = await readAllLogins(isUnlocked, (done, total) => {
        if (my === run.current) setProgress({ done, total });
      });
      const rep = await analyzeHealth(logins);
      if (my !== run.current) return;
      setRoot(r); setBase(rep); setBreaches(null); setProgress(null);
      if (breachOnRef.current) {
        // Passwords stay local to this call; only the rel → times-seen map is kept.
        setBreachProgress({ done: 0, total: 0 });
        try {
          const found = await checkBreaches(logins, (done, total) => {
            if (my === run.current) setBreachProgress({ done, total });
          });
          if (my === run.current && breachOnRef.current) setBreaches(found);
        } catch (e) {
          if (my === run.current && breachOnRef.current) setBreachError(e instanceof BreachCheckError ? e.message : "Couldn't check: offline");
        }
      }
    } catch (e) {
      if (my === run.current) setError(vaultErrorMessage(e));
    } finally {
      if (my === run.current) { setProgress(null); setBreachProgress(null); }
    }
  }, []);

  useEffect(() => { void check(); return () => { run.current++; }; }, [check]);

  const toggleBreach = (v: boolean) => {
    setBreachOn(v); breachOnRef.current = v; setBreachCheck(v);
    if (v) void check(); else { setBreaches(null); setBreachError(null); setBreachProgress(null); }
  };

  const report = useMemo(() => (base ? applyBreaches(base, breaches) : null), [base, breaches]);

  // Locking the vault drops the report.
  const unlocked = useVaultStore((s) => s.unlocked);
  useEffect(() => { if (!unlocked) onClose(); }, [unlocked, onClose]);

  const list = useMemo(() => (report ? itemsWithIssue(report, filter) : []), [report, filter]);
  const issueTotal = report ? report.items.filter((i) => i.issues.length).length : 0;

  return (
    <Dialog onClose={onClose} zClassName="z-[70]" size="lg" title="Vault health" icon="shield"
            headerActions={
              <Button size="sm" icon={<RefreshCw size={13} />} loading={!!progress} loadingText="Checking…"
                      onClick={() => void check()}>Re-check</Button>
            }>
      <DialogBody fill detail={breachOn
        ? "Checked on this device. The only thing sent is the breach lookup below, and passwords are never shown here."
        : "Checked on this device only. Nothing is sent anywhere, and passwords are never shown here."}>
          <div className="flex items-start gap-3">
            <Toggle size="sm" aria-label="Check passwords against known data breaches" value={breachOn} onChange={toggleBreach} />
            <div className="min-w-0 text-xs">
              <div className="font-medium">Check passwords against known data breaches</div>
              <div className="text-[var(--color-text-muted)]">
                Only the first 5 characters of each password's hash are sent to Have I Been Pwned.
              </div>
            </div>
          </div>
          {error && <div role="alert" className="text-xs text-[var(--color-danger)]">{error}</div>}
          {breachError && <div role="alert" className="text-xs text-[var(--color-danger)]">{breachError}</div>}
          {progress && (
            <InlineLoading label={`Checking logins${progress.total ? ` (${progress.done} of ${progress.total})` : ""}…`} />
          )}
          {breachProgress && (
            <InlineLoading label={`Checking for data breaches${breachProgress.total ? ` (${breachProgress.done} of ${breachProgress.total})` : ""}…`} />
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
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
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
                                {k === "reused" ? `Reused ×${it.reusedWith + 1}`
                                  : k === "old" ? `${it.ageDays} days old`
                                  : k === "breached" ? `Found in a data breach · seen ${it.breachedCount.toLocaleString()} ${it.breachedCount === 1 ? "time" : "times"}`
                                  : ISSUE_LABEL[k]}
                              </span>
                            ))}
                            {it.issues.includes("breached") && (
                              <span className="rounded px-1.5 py-0.5 text-[10px] text-[var(--color-primary)] underline">Change password</span>
                            )}
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
