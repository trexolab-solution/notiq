import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Paperclip } from "lucide-react";

/** The dashed box a `FileDropPrompt` sits in (add to a `DropZone` so every file box looks the same). */
export const fileDropBox = "!border !rounded-md";

/**
 * What every "add a file" box says: "Drag & drop … here, or browse", with `browse` as an underlined link.
 * `compact` puts it on one line, for a box under a list of files already added.
 */
export function FileDropPrompt({ what, hint, compact, browseText = "browse", buttonProps }: {
  /** What to drop: "files", "a .nqb share file". */
  what: ReactNode;
  hint?: ReactNode;
  compact?: boolean;
  browseText?: string;
  /** For the browse link: `onClick`, a label, `data-*` focus hooks. */
  buttonProps: ButtonHTMLAttributes<HTMLButtonElement> & { [data: `data-${string}`]: string };
}) {
  return (
    <div className={`flex items-center justify-center gap-x-3 gap-y-1 px-4 text-center ${compact ? "flex-wrap py-2.5" : "flex-col py-5"}`}>
      <Paperclip size={compact ? 14 : 18} aria-hidden className="shrink-0 text-[var(--color-text-muted)]" />
      <p className="text-sm text-[var(--color-text)]">
        Drag &amp; drop {what} here, or{" "}
        <button type="button" {...buttonProps}
                className="font-medium underline underline-offset-2 text-[var(--color-primary)] cursor-pointer rounded-sm hover:decoration-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 disabled:opacity-40 disabled:cursor-default aria-disabled:opacity-40 aria-disabled:cursor-not-allowed">
          {browseText}
        </button>
      </p>
      {hint && <p className="text-[11px] text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}
