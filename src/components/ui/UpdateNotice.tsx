import { useEffect, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { Button } from "./Button";
import { useUpdater } from "../../hooks/useUpdater";
import { updater } from "../../lib/updater";
import { APP_VERSION } from "../../config/app";
import logoUrl from "../../assets/logo.png";

/** How long "Later" keeps the card away before it asks again (the app can stay open for days). */
export const UPDATE_LATER_MS = 4 * 60 * 60 * 1000;

/**
 * "A new version is available", as a card over the app: the small pill in the title bar was easy to miss. It takes
 * no focus and blocks nothing. "Later" (or ×) puts it away for a few hours; a restart, or a newer version, shows
 * it again. The pill stays the whole time.
 *
 * It sits below every dialog (they start at z-50): above one, a click on it would open the update dialog behind
 * that dialog, with the focus on a button nobody can see.
 */
export function UpdateNotice() {
  const { status, version, dialogOpen } = useUpdater();
  const [later, setLater] = useState<{ version: string; until: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!later) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, later.until - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [later]);

  if (status !== "available" || !version || dialogOpen) return null;
  if (later && later.version === version && now < later.until) return null;
  const snooze = () => { setNow(Date.now()); setLater({ version, until: Date.now() + UPDATE_LATER_MS }); };

  return (
    <section aria-labelledby="update-notice-title" data-update-notice=""
             className="fixed right-4 top-12 z-[45] w-[20rem] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-[var(--color-text)] shadow-[0_8px_30px_rgb(0_0_0/0.18),0_1px_3px_rgb(0_0_0/0.1)]">
      <div className="flex items-center gap-3">
        <img src={logoUrl} alt="" className="h-9 w-9 shrink-0 select-none" draggable={false} />
        <div className="min-w-0 flex-1">
          {/* Announced once when it appears. */}
          <h2 id="update-notice-title" role="status" className="text-[13px] font-semibold leading-tight">Update available</h2>
          <p className="mt-1 flex items-center gap-1.5 text-xs leading-tight text-[var(--color-text-muted)] tabular-nums">
            <span className="sr-only">You have Notiq </span>{APP_VERSION}
            <ArrowRight size={11} aria-hidden />
            <span className="sr-only">, new version </span>
            <span className="font-semibold text-[var(--color-primary)]">{version}</span>
          </p>
        </div>
        <button type="button" aria-label="Close the update notice" onClick={snooze}
                className="-mr-1.5 -mt-1.5 shrink-0 cursor-pointer self-start rounded-md p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]">
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button size="sm" className="h-8 px-3" onClick={snooze}>Later</Button>
        <Button size="sm" variant="primary" className="h-8 px-3.5" onClick={() => updater.openDialog()}>Update now</Button>
      </div>
    </section>
  );
}
