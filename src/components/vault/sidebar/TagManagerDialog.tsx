import { useMemo, useRef, useState } from "react";
import { Check, Hash, Pencil, Search, Tags, Trash2, X } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../../ui/Dialog";
import { Tooltip } from "../../ui/Tooltip";
import { normalizeTags } from "../../../lib/vaultTree";

interface Props {
  tags: { tag: string; count: number }[];
  /** Renames `from` to `to` on every entry that has it (merging when `to` already exists). Resolves true on success. */
  onRename: (from: string, to: string) => Promise<boolean>;
  /** Removes `tag` from every entry that has it. Resolves true on success. */
  onDelete: (tag: string) => Promise<boolean>;
  onClose: () => void;
}

type Mode = { kind: "rename"; tag: string; draft: string } | { kind: "delete"; tag: string } | null;

/** Vault-wide tag housekeeping: rename (or merge into another tag) and delete, with how many entries each touches. */
export function TagManagerDialog({ tags, onRename, onDelete, onClose }: Props) {
  const [mode, setMode] = useState<Mode>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(() => [...tags].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" })), [tags]);
  const shown = filter.trim() ? sorted.filter((t) => t.tag.toLowerCase().includes(filter.trim().toLowerCase())) : sorted;
  const exists = (name: string, except: string) =>
    tags.some((t) => t.tag.toLowerCase() === name.toLowerCase() && t.tag.toLowerCase() !== except.toLowerCase());

  const commitRename = async (from: string, draft: string) => {
    const to = normalizeTags([draft])[0];
    if (!to || to === from) { setMode(null); return; }
    setBusy(true);
    const ok = await onRename(from, to);
    setBusy(false);
    if (ok) setMode(null);
  };
  const commitDelete = async (tag: string) => {
    setBusy(true);
    const ok = await onDelete(tag);
    setBusy(false);
    if (ok) setMode(null);
  };

  return (
    <Dialog onClose={onClose} zClassName="z-[70]" size="sm" title="Manage tags" icon={<Tags size={16} />}>
      <DialogBody detail="Renaming a tag to one that already exists merges them. Changes apply to every entry that has the tag.">
        {tags.length > 6 && (
          <label className="vt-search" style={{ margin: 0 }}>
            <Search size={13} aria-hidden />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a tag" aria-label="Find a tag" />
          </label>
        )}
        {tags.length === 0 ? (
          <p className="text-xs py-4 text-center text-[var(--color-text-muted)]">No tags yet. Add tags from an entry's menu or the selection bar.</p>
        ) : (
          <ul className="vt-tag-list" aria-label="Tags">
            {shown.map(({ tag, count }) => {
              const renaming = mode?.kind === "rename" && mode.tag === tag ? mode : null;
              const deleting = mode?.kind === "delete" && mode.tag === tag;
              return (
                <li key={tag} className="vt-tag-row">
                  {renaming ? (
                    <>
                      <Hash size={12} aria-hidden className="shrink-0 text-[var(--color-text-muted)]" />
                      <input
                        ref={inputRef}
                        autoFocus
                        className="vt-tag-edit"
                        value={renaming.draft}
                        maxLength={40}
                        aria-label={`New name for ${tag}`}
                        disabled={busy}
                        onChange={(e) => setMode({ kind: "rename", tag, draft: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitRename(tag, renaming.draft); }
                          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMode(null); }
                        }}
                      />
                      {exists(normalizeTags([renaming.draft])[0] ?? "", tag) && (
                        <span className="text-[11px] text-[var(--color-warning)]">merges</span>
                      )}
                      <Tooltip content="Save">
                        <button type="button" className="vt-icon-btn" aria-label="Save new name" disabled={busy}
                                onClick={() => void commitRename(tag, renaming.draft)}><Check size={13} /></button>
                      </Tooltip>
                      <Tooltip content="Cancel">
                        <button type="button" className="vt-icon-btn" aria-label="Cancel rename" onClick={() => setMode(null)}><X size={13} /></button>
                      </Tooltip>
                    </>
                  ) : deleting ? (
                    <>
                      <span className="flex-1 min-w-0 text-xs">Remove “{tag}” from {count} {count === 1 ? "entry" : "entries"}?</span>
                      <button type="button" className="vt-tag-confirm" disabled={busy} onClick={() => void commitDelete(tag)}>Remove</button>
                      <button type="button" className="vt-icon-btn" aria-label="Cancel" onClick={() => setMode(null)}><X size={13} /></button>
                    </>
                  ) : (
                    <>
                      <Hash size={12} aria-hidden className="shrink-0 text-[var(--color-text-muted)]" />
                      <span className="flex-1 min-w-0 truncate text-[13px]">{tag}</span>
                      <span className="vt-chip-count" aria-label={`${count} entries`}>{count}</span>
                      <Tooltip content="Rename or merge">
                        <button type="button" className="vt-icon-btn" aria-label={`Rename tag ${tag}`}
                                onClick={() => setMode({ kind: "rename", tag, draft: tag })}><Pencil size={12} /></button>
                      </Tooltip>
                      <Tooltip content="Delete tag">
                        <button type="button" className="vt-icon-btn" style={{ color: "var(--color-danger)" }} aria-label={`Delete tag ${tag}`}
                                onClick={() => setMode({ kind: "delete", tag })}><Trash2 size={12} /></button>
                      </Tooltip>
                    </>
                  )}
                </li>
              );
            })}
            {shown.length === 0 && <li className="text-xs py-3 text-center text-[var(--color-text-muted)]">No tag matches “{filter}”.</li>}
          </ul>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogButton variant="primary" onClick={onClose}>Done</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
