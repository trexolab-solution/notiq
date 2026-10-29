import React, { forwardRef } from "react";
import { Search, X } from "lucide-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Number of matching settings for a non-empty query. */
  resultCount: number;
}

/**
 * The Settings search field. Esc clears it (a second Esc, on an empty field, leaves it).
 * The result count is announced through a polite live region.
 */
export const SettingsSearchBox = forwardRef<HTMLInputElement, Props>(function SettingsSearchBox(
  { value, onChange, resultCount }, ref,
) {
  const searching = value.trim().length > 0;
  const countText = searching
    ? resultCount === 0 ? "No results" : `${resultCount} ${resultCount === 1 ? "setting" : "settings"}`
    : "";

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (value) { e.preventDefault(); onChange(""); }
    else e.currentTarget.blur();
  };

  return (
    <div className="settings-search" role="search">
      <Search size={14} className="settings-search-icon" aria-hidden />
      <input
        ref={ref}
        type="search"
        className="settings-search-input"
        placeholder="Search settings"
        aria-label="Search settings"
        aria-keyshortcuts="Control+F /"
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {searching && (
        <button
          type="button"
          className="settings-search-clear"
          aria-label="Clear search"
          onClick={() => { onChange(""); (ref as React.RefObject<HTMLInputElement>)?.current?.focus(); }}
        >
          <X size={13} aria-hidden />
        </button>
      )}
      <span className="settings-search-count" aria-live="polite" aria-atomic="true">{countText}</span>
    </div>
  );
});
