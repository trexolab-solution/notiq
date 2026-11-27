import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { useClickOutside } from "../../hooks/useClickOutside";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { formatUptime, type ServerReading } from "../../lib/serverOverview";

const POPUP_W = 320;
const MARGIN = 8;

/** The "i" beside the server overview: host name, system, kernel, uptime and processor, in a small popover. */
export function ServerDetailsButton({ reading: r }: { reading: ServerReading }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);

  // Under the button and inside the window: below it, else above it, else pinned to the top (it then scrolls inside
  // itself). Follows the button when the form scrolls or the window is resized.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      if (!trigger.current) return;
      const t = trigger.current.getBoundingClientRect();
      const width = Math.min(POPUP_W, window.innerWidth - 2 * MARGIN);
      const left = Math.max(MARGIN, Math.min(t.right - width, window.innerWidth - width - MARGIN));
      const h = Math.min(popup.current?.scrollHeight ?? 260, window.innerHeight - 2 * MARGIN);
      const below = t.bottom + 6;
      const above = t.top - h - 6;
      setPos({ left, top: below + h <= window.innerHeight - MARGIN ? below : above >= MARGIN ? above : MARGIN });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  // For keyboard and screen-reader users: the popover takes the focus once it is in place.
  const placed = pos !== null;
  useEffect(() => { if (placed) popup.current?.focus({ preventScroll: true }); }, [placed]);

  useClickOutside([trigger, popup], () => setOpen(false), open);
  useEscapeKey(() => { setOpen(false); trigger.current?.querySelector("button")?.focus(); }, open);

  const rows: [string, string][] = [
    ["Host name", r.hostname ?? "–"],
    ["Operating system", r.os ?? "Linux"],
    ["Kernel", [r.kernel, r.arch].filter(Boolean).join(" · ") || "–"],
    ["Up for", r.uptimeSecs === null ? "–" : formatUptime(r.uptimeSecs)],
    ...(r.cpuModel ? [["Processor", r.cpuModel] as [string, string]] : []),
  ];

  return (
    <div ref={trigger} className="shrink-0">
      <Tooltip content="Server details">
        <Button size="sm" icon={<Info size={13} />} aria-label="Server details" aria-haspopup="dialog" aria-expanded={open}
                className="!p-0 h-7 w-7 justify-center border border-[var(--color-border)]" onClick={() => setOpen((o) => !o)} />
      </Tooltip>
      {/* In the body: inside the scrolling, container-query column a "fixed" popover would be clipped and misplaced. */}
      {open && createPortal(
        <div ref={popup} role="dialog" aria-label="Server details" tabIndex={-1} data-server-details=""
             className="fixed z-50 flex flex-col overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] shadow-xl outline-none"
             style={{ width: `min(${POPUP_W}px, calc(100vw - ${2 * MARGIN}px))`, maxHeight: `calc(100vh - ${2 * MARGIN}px)`, ...(pos ?? { left: 0, top: 0, visibility: "hidden" }) }}>
          <p className="flex items-center gap-2 border-b border-[var(--color-border)] px-3.5 py-2.5 text-xs font-semibold">
            <Info size={13} aria-hidden className="text-[var(--color-primary)]" /> Server details
          </p>
          <dl className="flex flex-col px-3.5 py-1">
            {rows.map(([term, value]) => (
              <div key={term} className="flex items-baseline gap-3 border-b border-[var(--color-border)] py-2 last:border-b-0">
                <dt className="w-28 shrink-0 text-[11px] text-[var(--color-text-muted)]">{term}</dt>
                <dd className="min-w-0 flex-1 select-text break-words text-right text-[13px] tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </div>,
        document.body,
      )}
    </div>
  );
}
