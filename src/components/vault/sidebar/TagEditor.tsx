import { useMemo, useRef, useState } from "react";
import { Hash, Tags, X } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../../ui/Dialog";
import { normalizeTags } from "../../../lib/vaultTree";

interface Props {
  name: string;
  initial: string[];
  /** Every tag already used in the vault, for one-click suggestions. */
  allTags: string[];
  onSave: (tags: string[]) => Promise<boolean>;
  onClose: () => void;
}

/** Small chip editor: type + Enter (or comma) to add, × or Backspace to remove. */
export function TagEditor({ name, initial, allTags, onSave, onClose }: Props) {
  const [tags, setTags] = useState<string[]>(() => normalizeTags(initial));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (raw: string) => {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) setTags((t) => normalizeTags([...t, ...parts]));
    setDraft("");
  };
  const remove = (t: string) => setTags((xs) => xs.filter((x) => x !== t));

  const suggestions = useMemo(() => {
    const have = new Set(tags.map((t) => t.toLowerCase()));
    const q = draft.trim().replace(/^#/, "").toLowerCase();
    return allTags.filter((t) => !have.has(t.toLowerCase()) && (!q || t.toLowerCase().includes(q))).slice(0, 10);
  }, [allTags, tags, draft]);

  const save = async () => {
    if (busy) return;
    const final = normalizeTags(draft.trim() ? [...tags, ...draft.split(",")] : tags);
    setBusy(true);
    const ok = await onSave(final);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      onClose={onClose}
      zClassName="z-[70]"
      size="sm"
      title={`Tags for “${name}”`}
      icon={<Tags size={16} />}
      onSubmit={(e) => { e.preventDefault(); void save(); }}
    >
      <DialogBody detail="Tags help you find secrets. Only the names and tags are listed — contents stay encrypted.">
        <div className="vt-tag-input-wrap" onClick={() => inputRef.current?.focus()}>
          {tags.map((t) => (
            <span key={t} className="vt-chip is-active" style={{ cursor: "default" }}>
              <span className="vt-chip-label">{t}</span>
              <button type="button" className="vt-chip-x" aria-label={`Remove tag ${t}`} onClick={() => remove(t)}>
                <X size={11} />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            autoFocus
            value={draft}
            placeholder={tags.length ? "Add another…" : "Type a tag, press Enter"}
            aria-label="New tag"
            maxLength={40}
            spellCheck={false}
            onChange={(e) => {
              const v = e.target.value;
              if (v.includes(",")) add(v); else setDraft(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) { e.preventDefault(); add(draft); }
              else if (e.key === "Backspace" && !draft && tags.length) { e.preventDefault(); setTags((t) => t.slice(0, -1)); }
            }}
          />
        </div>

        {suggestions.length > 0 && (
          <div className="mt-2">
            <div className="text-[11px] mb-1 text-[var(--color-text-muted)]">Existing tags</div>
            <div className="flex flex-wrap gap-1">
              {suggestions.map((t) => (
                <button key={t} type="button" className="vt-chip" onClick={() => { add(t); inputRef.current?.focus(); }}>
                  <Hash size={10} aria-hidden /> <span className="vt-chip-label">{t}</span>
                </button>
              ))}
            </div>
          </div>
        )}

      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onClose}>Cancel</DialogButton>
        <DialogButton type="submit" variant="primary" disabled={busy}>Save tags</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
