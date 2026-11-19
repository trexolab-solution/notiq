import { useRef } from "react";
import { Search, X } from "lucide-react";

/** The vault search box. Esc clears it; Down moves into the tree (`onArrowDown`). */
export function ExplorerSearch({ query, onQuery, onArrowDown }: {
  query: string;
  onQuery: (q: string) => void;
  onArrowDown: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <label className="vt-search">
      <Search size={13} aria-hidden />
      <input
        ref={searchRef}
        type="search"
        value={query}
        placeholder="Search names, sites and tags"
        aria-label="Search vault by name, website, username or tag"
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); onQuery(""); }
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            onArrowDown();
          }
        }}
      />
      {query && (
        <button type="button" className="vt-icon-btn" style={{ width: 18, height: 18 }} aria-label="Clear search"
                onClick={() => { onQuery(""); searchRef.current?.focus(); }}>
          <X size={12} />
        </button>
      )}
    </label>
  );
}
