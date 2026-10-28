import { useState } from "react";
import { Hash, X } from "lucide-react";

interface Props {
  tags: { tag: string; count: number }[];
  selected: string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
}

const COLLAPSED_LIMIT = 8;

/**
 * Every tag in the vault with its count. Clicking toggles it as a filter;
 * several selected tags narrow the tree (AND). Selected tags always show,
 * even when the strip is collapsed.
 */
export function TagBar({ tags, selected, onToggle, onClear }: Props) {
  const [showAll, setShowAll] = useState(false);
  if (tags.length === 0) return null;

  const isSel = (t: string) => selected.some((s) => s.toLowerCase() === t.toLowerCase());
  const visible = showAll || tags.length <= COLLAPSED_LIMIT
    ? tags
    : tags.filter((t, i) => i < COLLAPSED_LIMIT || isSel(t.tag));
  const hidden = tags.length - visible.length;

  return (
    <div className="vt-tagbar" role="group" aria-label="Filter by tag">
      {visible.map(({ tag, count }) => {
        const active = isSel(tag);
        return (
          <button
            key={tag}
            type="button"
            className={`vt-chip${active ? " is-active" : ""}`}
            aria-pressed={active}
            title={`${active ? "Remove filter" : "Show only"} “${tag}” (${count})`}
            onClick={() => onToggle(tag)}
          >
            <Hash size={10} aria-hidden />
            <span className="vt-chip-label">{tag}</span>
            <span className="vt-chip-count">{count}</span>
          </button>
        );
      })}
      {hidden > 0 && (
        <button type="button" className="vt-chip" onClick={() => setShowAll(true)} aria-label={`Show ${hidden} more tags`}>
          +{hidden} more
        </button>
      )}
      {showAll && tags.length > COLLAPSED_LIMIT && (
        <button type="button" className="vt-chip" onClick={() => setShowAll(false)}>Less</button>
      )}
      {selected.length > 0 && (
        <button type="button" className="vt-chip" onClick={onClear} title="Clear tag filter">
          <X size={10} aria-hidden /> Clear
        </button>
      )}
    </div>
  );
}
