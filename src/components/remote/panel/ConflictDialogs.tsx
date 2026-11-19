import type { MutableRefObject } from "react";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { getFilesPrefs } from "../../../lib/filesPrefs";
import type { Conflict, MoveChoice } from "./types";

export type ReplaceAsk = { name: string; folder: boolean; answer: (c: Conflict) => void };
export type MoveConflictAsk = { name: string; many: boolean; answer: (c: MoveChoice) => void };

/** "This name is already taken" during an upload / download: replace it, or (for a folder) merge, or stop. */
export function ReplaceDialog({ replace, onDone }: { replace: ReplaceAsk; onDone: () => void }) {
  return replace.folder ? (
    <ConfirmDialog title={`Merge into the existing folder “${replace.name}”?`}
                   message={`A folder named “${replace.name}” is already in the destination. Files that are only in one of them stay as they are. What should happen to files that have the same name in both?`}
                   confirmLabel="Replace matching files" discardLabel="Skip matching files" cancelLabel="Cancel" danger
                   onConfirm={() => { replace.answer("replace"); onDone(); }}
                   onDiscard={() => { replace.answer("skip-matching"); onDone(); }}
                   onCancel={() => { replace.answer("cancel"); onDone(); }} />
  ) : (
    <ConfirmDialog title={`Replace “${replace.name}”?`}
                   message={`A file named “${replace.name}” already exists in this folder. Replacing it overwrites the existing file.`}
                   confirmLabel="Replace" cancelLabel="Keep existing" danger
                   onConfirm={() => { replace.answer("replace"); onDone(); }}
                   onCancel={() => { replace.answer("cancel"); onDone(); }} />
  );
}

/** "This name is already taken" while moving: replace, keep both or skip; optionally for all the other conflicts. */
export function MoveConflictDialog({ moveConflict, applyAll, onDone }: {
  moveConflict: MoveConflictAsk; applyAll: MutableRefObject<boolean>; onDone: () => void;
}) {
  return (
    <ConfirmDialog title={`“${moveConflict.name}” already exists there`}
                   message={`An item named “${moveConflict.name}” is already in the destination folder. Replace it${getFilesPrefs().useTrash ? " (the existing one goes to the Trash)" : " (the existing one is deleted)"}, keep both (this one is renamed), or skip it?`}
                   confirmLabel="Replace" discardLabel="Keep both" cancelLabel="Skip" danger
                   checkbox={moveConflict.many ? { label: "Do this for all the other conflicts", onChange: (v) => { applyAll.current = v; } } : undefined}
                   onConfirm={() => { moveConflict.answer({ choice: "replace", all: applyAll.current }); onDone(); }}
                   onDiscard={() => { moveConflict.answer({ choice: "keep_both", all: applyAll.current }); onDone(); }}
                   onCancel={() => { moveConflict.answer({ choice: "skip", all: applyAll.current }); onDone(); }} />
  );
}
