import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { createDialogStack, dialogKeyAction, initialFocusChoice, trapFocusTarget, type DefaultFocus } from "./dialogLogic";

/** One stack for every Dialog / Modal in the window. */
export const dialogStack = createDialogStack();

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])", "[contenteditable='true']",
].join(",");

/** Tabbable, visible elements inside `root`, in DOM order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.closest("[inert]") && el.getClientRects().length > 0,
  );
}

const focusEl = (el: HTMLElement | null | undefined) => { if (el) { el.focus({ preventScroll: true }); return true; } return false; };

export interface DialogBehaviourOptions {
  onClose: () => void;
  dismissable: boolean;
  /** Enter-to-confirm handler (see `dialogKeyAction` for when it fires). */
  onPrimary?: () => void;
  danger?: boolean;
  /** Move focus into the panel on open (Dialog: yes; the legacy Modal shell: no). */
  autoFocus?: boolean;
  defaultFocus?: DefaultFocus;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Shared modal behaviour: top-of-stack Escape (via useEscapeKey), Enter-to-primary,
 * a Tab focus trap, initial focus and focus restore on close.
 * Initial-focus order: an element already focused inside (e.g. an `autoFocus` input)
 * -> `initialFocusRef` -> the default action button (`data-dialog-default`, or
 * `data-dialog-cancel` for danger dialogs) -> the first tabbable in the body -> the
 * first tabbable anywhere -> the panel itself.
 */
export function useDialogBehaviour(panelRef: RefObject<HTMLElement | null>, opts: DialogBehaviourOptions) {
  // Allocated during render so a parent dialog always gets a lower id than a nested one.
  const [id] = useState(() => dialogStack.nextId());
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    dialogStack.add(id);
    // Captured once (StrictMode re-runs this effect after focus already moved inside).
    if (!openerRef.current) openerRef.current = document.activeElement as HTMLElement | null;
    const opener = openerRef.current;
    const panel = panelRef.current;
    const o = optsRef.current;
    if (panel && o.autoFocus && !panel.contains(document.activeElement)) {
      const choice = initialFocusChoice(!!o.danger, o.defaultFocus);
      const pick = (sel: string) => panel.querySelector<HTMLElement>(`${sel}:not(:disabled)`);
      const body = panel.querySelector<HTMLElement>("[data-dialog-body]");
      void (
        focusEl(o.initialFocusRef?.current) ||
        focusEl(choice === "cancel" ? pick("[data-dialog-cancel]") : pick("[data-dialog-default]")) ||
        focusEl(body ? tabbables(body)[0] : null) ||
        focusEl(tabbables(panel)[0]) ||
        focusEl(panel)
      );
    }
    return () => {
      dialogStack.remove(id);
      // Restore focus to whatever opened the dialog, if it is still on the page and nothing
      // else (e.g. the next dialog in a flow) has claimed focus in the meantime.
      if (opener && opener !== document.body) {
        requestAnimationFrame(() => {
          const active = document.activeElement;
          const lost = !active || active === document.body || !document.contains(active);
          if (lost && document.contains(opener)) opener.focus({ preventScroll: true });
        });
      }
    };
  }, [id, panelRef]);

  useEscapeKey((e) => {
    // An inner control (an open dropdown, an inline editor) already handled this Escape.
    if (e.defaultPrevented) return;
    const o = optsRef.current;
    if (dialogKeyAction({ key: "Escape" }, { isTop: dialogStack.isTop(id), dismissable: o.dismissable, hasPrimary: false, danger: false }) === "cancel") {
      e.preventDefault();
      o.onClose();
    }
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" && e.key !== "Enter") return;
      const panel = panelRef.current;
      if (!panel || e.defaultPrevented) return;
      const o = optsRef.current;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const action = dialogKeyAction(
        {
          key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
          isComposing: e.isComposing, targetTag: t?.tagName, targetType: (t as HTMLInputElement | null)?.type,
          targetInForm: !!t?.closest("form"), targetEditable: !!t?.isContentEditable,
        },
        { isTop: dialogStack.isTop(id), dismissable: o.dismissable, hasPrimary: !!o.onPrimary, danger: !!o.danger },
      );
      if (action === "primary") {
        // Only for keys pressed inside this panel (or with focus on the page body).
        if (t && t !== document.body && !panel.contains(t)) return;
        e.preventDefault();
        o.onPrimary?.();
      } else if (action === "trap") {
        const items = tabbables(panel);
        const idx = items.indexOf(document.activeElement as HTMLElement);
        const next = trapFocusTarget(items.length, idx, e.shiftKey);
        if (next === null) return;
        e.preventDefault();
        focusEl(next === -1 ? panel : items[next]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, panelRef]);

  return id;
}
