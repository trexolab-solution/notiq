import { useCallback } from "react";
import type { MouseEventHandler } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { joinRemote, type RemoteEntry } from "../../lib/sftp";

/** What a dragged row carries. */
export interface EntryDrag { name: string }
/** What a drop target (a folder row, or a crumb of the path bar) stands for: the remote folder an item is moved into. */
export interface EntryDrop { dest: string }

/**
 * Makes one listed item draggable (to move it) and, when it is a folder, a place to drop onto. Pointer based, like
 * the vault tree: the browser's own drag and drop is swallowed by the window's file-drop handling.
 */
export function useEntryDnd(e: RemoteEntry, dir: string) {
  const drag = useDraggable({ id: `entry:${e.name}`, data: { name: e.name } satisfies EntryDrag });
  const drop = useDroppable({ id: `drop:${e.name}`, data: { dest: joinRemote(dir, e.name) } satisfies EntryDrop, disabled: e.kind !== "dir" });
  const setRef = useCallback((el: HTMLDivElement | null) => { drag.setNodeRef(el); drop.setNodeRef(el); }, [drag.setNodeRef, drop.setNodeRef]);
  return {
    setRef,
    /** Spread on the row: starts a drag after the pointer has moved a little (a plain click still selects). */
    listeners: drag.listeners as { onPointerDown?: MouseEventHandler } | undefined,
    dragging: drag.isDragging,
    /** A drag is over this folder. */
    over: drop.isOver && !drag.isDragging,
  };
}
