import type { ReactNode } from "react";
import { Lock, LockOpen } from "lucide-react";

/** "Secure Vault" title row; `actions` go on the right. */
export function PanelHeader({ unlocked, actions }: { unlocked: boolean; actions?: ReactNode }) {
  return (
    <div className="flex items-center gap-0.5 pl-3 pr-2 pt-2.5 pb-2">
      {unlocked
        ? <LockOpen size={14} className="shrink-0 text-[var(--color-primary)]" aria-hidden />
        : <Lock size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />}
      <h2 className="ml-1.5 flex-1 truncate text-xs font-semibold text-[var(--color-text)]">Secure Vault</h2>
      {actions}
    </div>
  );
}
