import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Ellipsis, FileUp, Lock, LockOpen, ShieldCheck } from "lucide-react";
import { VaultHealthDialog } from "../VaultHealthDialog";
import { ImportDialog } from "../ImportDialog";
import { SyncBadge } from "./SyncBadge";
import { Tooltip } from "../../ui/Tooltip";
import { ContextMenu, type ContextMenuItem } from "../../ui/ContextMenu";

const icon = (el: JSX.Element) => <span className="inline-flex">{el}</span>;

/**
 * "Secure Vault" title row; `actions` (the frequent toolbar buttons) go on the right, followed — when
 * unlocked — by a "More actions" menu holding the rare ones: Vault health, Import logins, plus `moreItems`.
 */
export function PanelHeader({ unlocked, actions, moreItems = [] }: {
  unlocked: boolean;
  actions?: ReactNode;
  /** Extra entries for the "More actions" menu (view options), after the built-in ones. */
  moreItems?: ContextMenuItem[];
}) {
  const [dialog, setDialog] = useState<"health" | "import" | null>(null);
  const close = useCallback(() => setDialog(null), []);

  const moreBtn = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // The outside press that closes the menu can land on the button: its click must not re-open it.
  const closingByPress = useRef(false);
  const openMenu = () => {
    const r = moreBtn.current?.getBoundingClientRect();
    if (r) setMenuAt({ x: r.right, y: r.bottom + 4 });
  };
  const closeMenu = () => {
    setMenuAt(null);
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('[role="menu"]')) moreBtn.current?.focus({ preventScroll: true });
  };

  const items: ContextMenuItem[] = [
    { type: "item", label: "Vault health…", icon: icon(<ShieldCheck size={14} />), onClick: () => setDialog("health") },
    { type: "item", label: "Import logins from CSV…", icon: icon(<FileUp size={14} />), onClick: () => setDialog("import") },
    ...(moreItems.length ? [{ type: "separator" } as ContextMenuItem, ...moreItems] : []),
  ];

  return (
    <div className="flex items-center gap-0.5 pl-3 pr-2 pt-2.5 pb-2">
      {unlocked
        ? <LockOpen size={14} className="shrink-0 text-[var(--color-primary)]" aria-hidden />
        : <Lock size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />}
      <h2 className="ml-1.5 min-w-0 truncate whitespace-nowrap text-xs font-semibold text-[var(--color-text)]" title="Secure Vault">Vault</h2>
      <SyncBadge />
      <span className="min-w-0 flex-1" />
      {actions}
      {unlocked && (
        <Tooltip content="More actions" description="Vault health, import, view options" disabled={!!menuAt}>
          <button
            ref={moreBtn}
            type="button"
            className="vt-icon-btn"
            aria-label="More vault actions"
            aria-haspopup="menu"
            aria-expanded={!!menuAt}
            onMouseDown={() => { closingByPress.current = !!menuAt; }}
            onClick={() => {
              if (closingByPress.current) { closingByPress.current = false; return; }
              openMenu();
            }}
            onKeyDown={(e) => { if (e.key === "ArrowDown" && !menuAt) { e.preventDefault(); openMenu(); } }}
          >
            <Ellipsis size={15} />
          </button>
        </Tooltip>
      )}
      {menuAt && (
        <ContextMenu x={menuAt.x} y={menuAt.y} align="end" autoFocusFirst label="More vault actions"
                     items={items} onClose={closeMenu} />
      )}
      {unlocked && dialog && createPortal(
        dialog === "health" ? <VaultHealthDialog onClose={close} /> : <ImportDialog onClose={close} />,
        document.body,
      )}
    </div>
  );
}
