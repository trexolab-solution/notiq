import { useMemo, useState } from "react";
import { FolderInput, Search } from "lucide-react";
import { Modal } from "../../ui/Modal";
import { Button } from "../../ui/Button";
import { canMoveTo, displayName, parentRel } from "../../../lib/vaultTree";
import { EntryIcon } from "./EntryIcon";

interface Props {
  /** The entry being moved. */
  rel: string;
  name: string;
  folders: string[];
  onMove: (destFolder: string) => void;
  onClose: () => void;
}

/** "Move to…" folder picker. Folders that aren't valid targets are shown disabled. */
export function MoveDialog({ rel, name, folders, onMove, onClose }: Props) {
  const [q, setQ] = useState("");
  const options = useMemo(() => ["", ...folders], [folders]);
  const firstValid = options.find((f) => canMoveTo(rel, f));
  const [sel, setSel] = useState<string | undefined>(firstValid);

  const query = q.trim().toLowerCase();
  const shown = query ? options.filter((f) => f && f.toLowerCase().includes(query)) : options;

  return (
    <Modal onClose={onClose} zClassName="z-[70]">
      <form
        className="vt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vt-move-title"
        onSubmit={(e) => { e.preventDefault(); if (sel !== undefined && canMoveTo(rel, sel)) onMove(sel); }}
      >
        <div className="flex items-center gap-2 mb-3">
          <FolderInput size={15} className="text-[var(--color-primary)]" aria-hidden />
          <h2 id="vt-move-title" className="text-sm font-semibold truncate">Move “{name}” to…</h2>
        </div>

        {folders.length > 6 && (
          <label className="vt-search" style={{ margin: 0 }}>
            <Search size={13} aria-hidden />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a folder" aria-label="Find a folder" />
          </label>
        )}

        <div className="vt-folder-list" role="listbox" aria-label="Destination folder">
          {shown.map((f) => {
            const ok = canMoveTo(rel, f);
            const here = parentRel(rel) === f;
            const depth = f ? f.split("/").length : 0;
            return (
              <button
                key={f || "(root)"}
                type="button"
                role="option"
                aria-selected={sel === f}
                disabled={!ok}
                className={`vt-folder-opt${sel === f ? " is-active" : ""}`}
                style={{ paddingLeft: 8 + (query ? 0 : depth * 14) }}
                title={f || "Vault root"}
                onClick={() => setSel(f)}
                onDoubleClick={() => ok && onMove(f)}
              >
                <EntryIcon kind="folder" open={sel === f} />
                <span className="truncate flex-1">{f ? (query ? f : displayName(f)) : "Vault (top level)"}</span>
                {here && <span className="text-[11px] text-[var(--color-text-muted)]">current</span>}
              </button>
            );
          })}
          {shown.length === 0 && <p className="text-xs px-2 py-3 text-[var(--color-text-muted)]">No folder matches “{q}”.</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={sel === undefined || !canMoveTo(rel, sel)} autoFocus={folders.length <= 6}>
            Move here
          </Button>
        </div>
      </form>
    </Modal>
  );
}
