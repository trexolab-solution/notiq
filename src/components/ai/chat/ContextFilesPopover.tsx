import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckSquare, FileCode, FileText, NotebookText, Square } from "lucide-react";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { useEscapeKey } from "../../../hooks/useEscapeKey";
import { computePopoverPos } from "../../../lib/popoverPosition";
import type { Tab } from "../../../types";
import { isCodeTab, tabLabel } from "./contextFiles";

/** Checklist popover anchored off the context pill's chevron — lets the user
 *  pick which open note/file tabs are included as chat context (Cursor-style). */
export function ContextFilesPopover({ tabs, selected, onToggle, onSelectAll, onClearAll, onClose, anchorRef }: {
  tabs: Tab[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<ReturnType<typeof computePopoverPos> | null>(null);

  useEffect(() => {
    if (anchorRef.current) setPos(computePopoverPos(anchorRef.current, { minWidth: 260, maxHeight: 300 }));
  }, [anchorRef]);

  useClickOutside([anchorRef, popRef], onClose, true);
  useEscapeKey(onClose, true);

  if (!pos) return null;

  const allSelected = tabs.length > 0 && tabs.every((t) => selected.has(t.id));

  return createPortal(
    <div
      ref={popRef}
      className="ai-chat__ctx-popover"
      style={{ position: "fixed", top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
    >
      {tabs.length === 0 ? (
        <div className="ai-chat__ctx-popover-empty">
          <FileText size={18} />
          <span>No open notes/files</span>
        </div>
      ) : (
        <>
          <div className="ai-chat__ctx-popover-head">
            <span className="ai-chat__ctx-popover-count">{selected.size} of {tabs.length} selected</span>
            <button type="button" className="ai-chat__ctx-popover-selectall" onClick={allSelected ? onClearAll : onSelectAll}>
              {allSelected ? "Clear" : "Select all"}
            </button>
          </div>
          <ul className="ai-chat__ctx-popover-list">
            {tabs.map((t) => {
              const isSel = selected.has(t.id);
              const isCode = isCodeTab(t);
              return (
                <li
                  key={t.id}
                  className={`ai-chat__ctx-popover-row${isSel ? " is-selected" : ""}`}
                  onClick={() => onToggle(t.id)}
                >
                  {isSel ? <CheckSquare size={13} className="ai-chat__ctx-popover-check" /> : <Square size={13} className="ai-chat__ctx-popover-check" />}
                  {isCode
                    ? <FileCode size={13} className="ai-chat__ctx-popover-icon is-code" />
                    : <NotebookText size={13} className="ai-chat__ctx-popover-icon" />}
                  <span className="ai-chat__ctx-popover-label">{tabLabel(t)}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>,
    document.body,
  );
}
