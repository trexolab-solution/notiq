import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { registerDropTarget } from "../../lib/dropTargets";
import { useLatest } from "../../hooks/useLatest";

export interface DropTargetOptions {
  /** Unique per mounted target (re-registering the same id replaces the older one). */
  id: string;
  /** The element whose box receives drops. */
  element: () => Element | null;
  /** Checked on every hit-test. */
  enabled: boolean;
  /** Belongs to a modal dialog: wins over every other target and swallows drops elsewhere (lib/dropTargets). */
  modal?: boolean;
  onDrop: (paths: string[]) => void;
}

/**
 * Registers an OS file drop target with lib/dropTargets (routed by the global handler in
 * hooks/useAppStartup) and returns whether a drag is over it. Callbacks are read fresh on every event.
 */
export function useDropTarget({ id, element, enabled, modal, onDrop }: DropTargetOptions): boolean {
  const [hover, setHover] = useState(false);
  const latest = useLatest({ element, enabled, onDrop });
  useEffect(() => registerDropTarget({
    id,
    modal,
    element: () => latest.current.element(),
    enabled: () => latest.current.enabled,
    onHover: setHover,
    onDrop: (paths) => latest.current.onDrop(paths),
  }), [id, modal, latest]);
  useEffect(() => { if (!enabled) setHover(false); }, [enabled]);
  return hover && enabled;
}

/**
 * The "drop here" highlight: a dashed primary outline over its positioned parent with a label pill.
 * Purely visual (pointer-events: none); used by the attachments panel and by `DropZone`.
 */
export function DropHighlight({ icon, children, className = "absolute inset-2 z-30" }: {
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div data-drop-highlight=""
         className={`pointer-events-none flex items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-primary)] bg-[var(--color-primary)]/10 ${className}`}>
      <div className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium shadow-md bg-[var(--color-bg-secondary)] text-[var(--color-text)] border border-[var(--color-border)]">
        {icon && <span aria-hidden className="inline-flex text-[var(--color-primary)]">{icon}</span>}
        {children}
      </div>
    </div>
  );
}

/**
 * A visible drop area (dashed box) that is also a registered drop target. Children are its resting
 * content (icon, "Drop a file here, or Choose file"); while a file is dragged over it, the shared
 * `DropHighlight` with `hoverLabel` covers it.
 */
export function DropZone({ id, enabled = true, modal, onDrop, hoverLabel, hoverIcon, children, className = "" }: {
  id: string;
  enabled?: boolean;
  modal?: boolean;
  onDrop: (paths: string[]) => void;
  hoverLabel: ReactNode;
  hoverIcon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hover = useDropTarget({ id, element: () => ref.current, enabled, modal, onDrop });
  return (
    <div ref={ref} data-drop-zone="" data-hover={hover || undefined}
         className={`relative rounded-lg border-2 border-dashed transition-colors ${hover
           ? "border-transparent" : "border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/40"} ${className}`}>
      <div className={hover ? "invisible" : undefined}>{children}</div>
      {hover && <DropHighlight icon={hoverIcon} className="absolute -inset-0.5 z-10">{hoverLabel}</DropHighlight>}
    </div>
  );
}
