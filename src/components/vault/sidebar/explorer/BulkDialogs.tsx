import type { VaultItem } from "../../../../lib/vault";
import { ConfirmDialog } from "../../../ui/ConfirmDialog";
import * as A from "../actions";
import { TagEditor } from "../TagEditor";
import { MoveDialog } from "../MoveDialog";

/** The dialogs for the ticked rows: add tags, move, move to Trash. */
export function BulkDialogs({
  root, pickedItems, allTags, folders, tagging, moving, confirmingTrash,
  onCloseTagging, onCloseMoving, onCloseTrash, onMove, onDone,
}: {
  root: string;
  pickedItems: VaultItem[];
  allTags: string[];
  folders: string[];
  tagging: boolean;
  moving: boolean;
  confirmingTrash: boolean;
  onCloseTagging: () => void;
  onCloseMoving: () => void;
  onCloseTrash: () => void;
  /** Move the ticked rows into `dest`. */
  onMove: (dest: string) => void;
  /** The action went through: clear the ticks. */
  onDone: () => void;
}) {
  return (
    <>
      {tagging && (
        <TagEditor
          name={`${pickedItems.filter((i) => !i.dir).length || pickedItems.length} selected items`}
          initial={[]}
          allTags={allTags}
          onSave={async (t) => {
            const ok = await A.addTagsMany(root, pickedItems.map((i) => ({ rel: i.rel, tags: i.tags ?? [] })), t);
            if (ok) onDone();
            return ok;
          }}
          onClose={onCloseTagging}
        />
      )}
      {moving && pickedItems.length > 0 && (
        <MoveDialog
          rel={pickedItems[0].rel}
          rels={pickedItems.map((i) => i.rel)}
          name={`${pickedItems.filter((i) => !i.dir).length || pickedItems.length} items`}
          folders={folders}
          onClose={onCloseMoving}
          onMove={(dest) => { onCloseMoving(); onMove(dest); }}
        />
      )}
      {confirmingTrash && (
        <ConfirmDialog
          title="Move selected items to Trash?"
          message={`${pickedItems.length} item${pickedItems.length === 1 ? "" : "s"} (and anything inside the folders among them) will be moved to Trash. You can restore them for 30 days.`}
          confirmLabel="Move to Trash"
          danger
          onCancel={onCloseTrash}
          onConfirm={() => {
            onCloseTrash();
            void A.trashMany(root, pickedItems.map((i) => ({ rel: i.rel, dir: i.dir }))).then(() => onDone());
          }}
        />
      )}
    </>
  );
}
