import { ChevronsDownUp, ChevronsUpDown, FolderPlus, Lock } from "lucide-react";
import { useAppStore } from "../../../../store";
import type { NewEntryKind } from "../../../../lib/vaultCreate";
import { Tooltip } from "../../../ui/Tooltip";
import { NewEntryMenu } from "../NewEntryMenu";

/** The header's buttons: new entry, new folder, expand / collapse all folders, lock. */
export function ExplorerHeaderActions({ targetLabel, onCreate, onNewFolder, foldersOpen, collapseDisabled, filtering, onCollapseAll, onExpandAll }: {
  targetLabel: string;
  onCreate: (kind: NewEntryKind) => void;
  onNewFolder: () => void;
  foldersOpen: boolean;
  collapseDisabled: boolean;
  filtering: boolean;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}) {
  return (
    <>
      {/* Most used first: create, then tree view, then lock; the rest is under "More actions". */}
      <NewEntryMenu targetLabel={targetLabel} onPick={onCreate} />
      <Tooltip content="New folder" description={`Creates in ${targetLabel}`}>
        <button type="button" className="vt-icon-btn" aria-label={`New folder in ${targetLabel}`}
                onClick={onNewFolder}>
          <FolderPlus size={14} />
        </button>
      </Tooltip>
      <Tooltip
        content={foldersOpen ? "Collapse all folders" : "Expand all folders"}
        description={collapseDisabled ? (filtering ? "Clear the search to collapse folders" : "No folders yet") : undefined}
      >
        <button
          type="button"
          className="vt-icon-btn"
          aria-label={foldersOpen ? "Collapse all folders" : "Expand all folders"}
          aria-pressed={!foldersOpen}
          // aria-disabled (not disabled) so the tooltip still explains why.
          aria-disabled={collapseDisabled || undefined}
          onClick={() => {
            if (collapseDisabled) return;
            if (foldersOpen) onCollapseAll(); else onExpandAll();
          }}
        >
          {foldersOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
        </button>
      </Tooltip>
      <Tooltip content="Lock vault now">
        <button type="button" className="vt-icon-btn" aria-label="Lock vault now"
                onClick={() => void useAppStore.getState().lockVault()}>
          <Lock size={13} />
        </button>
      </Tooltip>
    </>
  );
}
