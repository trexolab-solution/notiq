import { useRef } from "react";
import type { FormEvent, ReactNode, RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "lucide-react";
import { DialogFooter, DialogIcon } from "../../components/ui/DialogParts";
import { Avatar } from "../../components/ui/Avatar";
import { useDialogBehaviour } from "../../components/ui/useDialogBehaviour";
import type { DefaultFocus } from "../../components/ui/dialogLogic";
import { splitHost } from "../hostParts";
import type { Job } from "../promptMachine";

export interface Refs {
  headRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  footRef: RefObject<HTMLDivElement>;
}

interface PanelProps {
  refs: Refs;
  host: string;
  /** Shown instead of the host (a request that is not about a site, like the popup's Unlock). */
  title?: string;
  sub: ReactNode;
  /** "site": the site's letter avatar, with `kind` (what will be filled) as its badge and as a chip. */
  icon: "shield" | "site" | ReactNode;
  kind?: Kind;
  tone?: "primary" | "danger";
  onClose: () => void;
  /** Escape does this instead of `onClose` (e.g. back from a details view); the close button still closes. */
  onEscape?: () => void;
  defaultFocus?: DefaultFocus;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  /** null: no footer (the details view has its own actions). */
  footer: ReactNode | null;
  children: ReactNode;
}

/** What a request will fill, for the header ("Login", "Payment card"…). */
export interface Kind { icon: ReactNode; label: string }

/** Dragging the header moves the window (the window has no title bar); buttons in it stay clickable. */
function dragWindow(e: React.MouseEvent<HTMLElement>) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
  void getCurrentWindow().startDragging().catch(() => { /* not in a Tauri window (tests) */ });
}

/** The whole window as one dialog: site header, scrolling body, footer. Esc / × = deny. */
export function Panel({ refs, host, title, sub, icon, kind, tone = "primary", onClose, onEscape, defaultFocus, onSubmit, footer, children }: PanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  useDialogBehaviour(panelRef, { onClose: onEscape ?? onClose, dismissable: true, autoFocus: true, defaultFocus });
  const { prefix, site } = splitHost(host);
  const inner = (
    <>
      <div ref={refs.headRef} className="af-head" onMouseDown={dragWindow}>
        {icon === "site" ? <Avatar name={site} size={36} badge={kind?.icon} className="af-site-avatar" />
          : icon === "shield" ? <DialogIcon kind="shield" /> : <DialogIcon tone={tone}>{icon}</DialogIcon>}
        <div className="af-head-text">
          <h1 className="af-host" id="af-title">
            {title ?? <>{prefix && <span className="af-host-prefix">{prefix}</span>}{site}</>}
          </h1>
          <p className="af-sub" id="af-desc">
            {kind && <span className="af-kind">{kind.icon}{kind.label}</span>}
            {kind && <span className="sr-only">: </span>}
            {sub}
          </p>
        </div>
        <button type="button" className="dlg-close" aria-label="Close" onClick={onClose}>
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
      <div className="af-scroll">
        <div ref={refs.contentRef} className="af-content">{children}</div>
      </div>
      <div ref={refs.footRef}>
        {footer != null && <DialogFooter>{footer}</DialogFooter>}
      </div>
    </>
  );
  const common = {
    ref: panelRef as never,
    className: "af-window",
    role: "alertdialog" as const,
    "aria-modal": true,
    "aria-labelledby": "af-title",
    "aria-describedby": "af-desc",
    tabIndex: -1,
  };
  return onSubmit ? <form {...common} onSubmit={onSubmit}>{inner}</form> : <div {...common}>{inner}</div>;
}

/** The site a request is about; empty for the popup's Unlock. */
export const jobHost = (job: Job): string => (job.kind === "unlock" ? "" : job.req.host);
