import { useEffect, useState } from "react";
import { ContextMenu, type ContextMenuItem } from "../components/ui/ContextMenu";
import { classifyContextTarget } from "../lib/contextMenu/target";
import { buildTextFieldMenu, textFieldAt } from "../lib/contextMenu/textField";

interface Options {
  /** False for windows without clipboard permission: no text menu, only suppression. */
  textMenu?: boolean;
}

/**
 * Right-click handling for the small secondary windows (sticky notes, quick
 * search, autofill prompt): text fields get Cut / Copy / Paste / Select all,
 * everything else gets nothing — the webview's own menu never shows. Surfaces
 * with their own menu (a sticky note's editor) handle the event first.
 * Returns the menu element to render.
 */
export function useWindowContextMenu({ textMenu = true }: Options = {}) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const field = textMenu && classifyContextTarget(e.target instanceof Element ? e.target : null) === "text-field"
        ? textFieldAt(e.target)
        : null;
      const items = field ? buildTextFieldMenu(field) : [];
      setMenu(items.length ? { x: e.clientX, y: e.clientY, items } : null);
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, [textMenu]);

  return menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} keepFocus onClose={() => setMenu(null)} />;
}
