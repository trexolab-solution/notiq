import { createContext, useContext, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

/** Where a docked panel is being shown: as one of the form's sections, or in the column on the right. */
export type DockPlace = "section" | "side";

const DockContext = createContext<{ place: DockPlace; at: HTMLElement | null }>({ place: "section", at: null });
/** `at` is the element the panel is attached to right now (none before it is first put somewhere). */
export const useDock = () => useContext(DockContext);

/**
 * Content that moves between two places without being mounted again. It is rendered into an element of its own,
 * which is put into whichever `slot` is current: a live connection (and what it has read) survives the window being
 * resized or the History panel opening, which a different place in the React tree would not.
 */
export function DockedPanel({ slot, place, children }: { slot: HTMLElement | null; place: DockPlace; children: React.ReactNode }) {
  const [host] = useState(() => {
    const el = document.createElement("div");
    // Its own size container: the panel lays itself out by the width of the place it is in.
    el.className = "@container flex flex-col gap-6";
    return el;
  });
  // Told to the content only once it is true: what the panel sits in can only be looked up after it is attached.
  const [at, setAt] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!slot) return;
    slot.appendChild(host);
    setAt(slot);
    return () => { host.remove(); };
  }, [slot, host]);
  return createPortal(<DockContext.Provider value={{ place, at }}>{children}</DockContext.Provider>, host);
}
