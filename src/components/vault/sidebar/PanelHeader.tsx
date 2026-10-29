import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileUp, Lock, LockOpen, ShieldCheck } from "lucide-react";
import { VaultHealthDialog } from "../VaultHealthDialog";
import { ImportDialog } from "../ImportDialog";

/** "Secure Vault" title row; `actions` go on the right. When unlocked it also offers Vault health and Import. */
export function PanelHeader({ unlocked, actions }: { unlocked: boolean; actions?: ReactNode }) {
  const [dialog, setDialog] = useState<"health" | "import" | null>(null);
  const close = useCallback(() => setDialog(null), []);
  return (
    <div className="flex items-center gap-0.5 pl-3 pr-2 pt-2.5 pb-2">
      {unlocked
        ? <LockOpen size={14} className="shrink-0 text-[var(--color-primary)]" aria-hidden />
        : <Lock size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />}
      <h2 className="ml-1.5 flex-1 truncate text-xs font-semibold text-[var(--color-text)]">Secure Vault</h2>
      {unlocked && (
        <>
          <button type="button" className="vt-icon-btn" title="Vault health — check for weak, reused and old passwords"
                  aria-label="Vault health" onClick={() => setDialog("health")}>
            <ShieldCheck size={14} />
          </button>
          <button type="button" className="vt-icon-btn" title="Import logins from a CSV file" aria-label="Import logins"
                  onClick={() => setDialog("import")}>
            <FileUp size={14} />
          </button>
        </>
      )}
      {actions}
      {unlocked && dialog && createPortal(
        dialog === "health" ? <VaultHealthDialog onClose={close} /> : <ImportDialog onClose={close} />,
        document.body,
      )}
    </div>
  );
}
