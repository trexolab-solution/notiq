import { Lock, LockOpen, ShieldCheck, type LucideIcon } from "lucide-react";
import { Button } from "../ui/Button";

interface Props {
  /** What is locked. */
  icon: LucideIcon;
  /** Puts a small lock on the icon, for an icon that isn't a lock itself. */
  badge?: boolean;
  /** Small line above the title (the kind of item). */
  eyebrow?: string;
  title: string;
  titleId?: string;
  text: string;
  action: string;
  onUnlock: () => void;
  busy?: boolean;
  /** The reassurance under the button. */
  note: string;
  autoFocus?: boolean;
}

/**
 * What stands in place of locked content, in the editor and in the vault sidebar: no card, just the thing that is
 * locked, one button, and one line about what stays encrypted.
 */
export function LockHero({ icon: Icon, badge, eyebrow, title, titleId, text, action, onUnlock, busy, note, autoFocus }: Props) {
  return (
    <div className="flex flex-col items-center text-center w-full max-w-[19rem]">
      <div className="relative mb-7 flex h-[72px] w-[72px] items-center justify-center">
        {/* Two rings behind the icon, the wider one fainter. */}
        <span aria-hidden className="absolute -inset-3 rounded-full border border-[var(--color-primary)]/20" />
        <span aria-hidden className="absolute -inset-6 rounded-full border border-[var(--color-primary)]/10" />
        <span className="relative flex h-full w-full items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
          <Icon size={30} strokeWidth={1.6} aria-hidden />
        </span>
        {badge && (
          <span className="absolute -right-0.5 -bottom-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-primary)] text-[var(--color-bg)] ring-[3px] ring-[var(--color-editor-bg)]">
            <Lock size={12} strokeWidth={2.4} aria-hidden />
          </span>
        )}
      </div>
      {eyebrow && <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-primary)]">{eyebrow}</p>}
      <h2 id={titleId} className="max-w-full break-words text-[17px] font-semibold leading-snug text-[var(--color-text)]">{title}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-text-muted)]">{text}</p>
      <Button variant="primary" icon={<LockOpen size={14} />} onClick={onUnlock} loading={busy} loadingText="Unlocking…" autoFocus={autoFocus}
              className="mt-5 h-9 w-full max-w-[13rem] justify-center">
        {action}
      </Button>
      <p className="mt-6 flex items-start justify-center gap-1.5 text-[11px] leading-snug text-[var(--color-text-muted)]">
        <ShieldCheck size={13} aria-hidden className="mt-px shrink-0 text-[var(--color-success)]" />
        <span>{note}</span>
      </p>
    </div>
  );
}
