import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, ChevronDown, Check, Cpu } from "lucide-react";
import { useClickOutside } from "../../hooks/useClickOutside";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { computePopoverPos } from "../../lib/popoverPosition";
import { formatContextLength, isFreeModel, usageLevelFor, usageLevelLabel, usageLevelHelp, type UsageLevel } from "../../lib/ai/models";
import { Tooltip } from "../ui/Tooltip";
import type { AIProvider } from "../../types";

const PROVIDER_LABEL: Record<AIProvider, string> = { cloud: "Cloud", local: "Local", openrouter: "OpenRouter" };

export interface ModelPickerModel {
  id: string;
  provider?: AIProvider;
  context_length?: number;
}

interface ExtraOption {
  value: string;
  label: string;
}

interface Row {
  key: string;
  id: string;
  provider?: AIProvider;
  free: boolean;
  usageLevel: UsageLevel | null;
  ctxLabel: string | null;
}

function toRow(m: ModelPickerModel, unified: boolean): Row {
  return {
    key: unified ? `${m.provider}::${m.id}` : m.id,
    id: m.id,
    provider: m.provider,
    free: isFreeModel(m.id, m.provider),
    usageLevel: usageLevelFor(m.id, m.provider),
    ctxLabel: formatContextLength(m.context_length),
  };
}

/** Small badge chip shared by trigger + rows. Forwards extra props (e.g. from
 *  Tooltip's cloned mouse/focus handlers) onto the underlying span. */
function Badge({
  tone = "muted", children, ...rest
}: { tone?: "muted" | "free" | "paid" | "heavy"; children: React.ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={`model-picker__badge model-picker__badge--${tone}`} {...rest}>{children}</span>;
}

function RowBadges({ row, unified }: { row: Row; unified: boolean }) {
  return (
    <span className="model-picker__row-badges">
      {row.free && <Badge tone="free">Free</Badge>}
      {/* Only OpenRouter has a reliable non-free signal (no :free suffix). */}
      {!row.free && row.provider === "openrouter" && <Badge tone="paid">Paid</Badge>}
      {/* Ollama Cloud (or a Local model proxied through it) has no free/paid
       *  gate — every model is reachable on every plan — so it gets a usage
       *  level instead (1 = light, 4 = extra-heavy quota burn). */}
      {row.usageLevel != null && (
        <Tooltip content={usageLevelHelp(row.usageLevel)}>
          <Badge tone={row.usageLevel >= 3 ? "heavy" : "muted"}>{usageLevelLabel(row.usageLevel)}</Badge>
        </Tooltip>
      )}
      {unified && row.provider && <Badge>{PROVIDER_LABEL[row.provider]}</Badge>}
      {row.ctxLabel && <Badge>{row.ctxLabel}</Badge>}
    </span>
  );
}

interface ModelPickerProps {
  value: string;
  onChange: (v: string) => void;
  models: ModelPickerModel[];
  /** Chat's cross-provider mode: composite `${provider}::${id}` values + a
   *  provider badge per row, instead of a single provider's bare model ids. */
  unified?: boolean;
  /** Pinned entries shown above the searchable list regardless of the query
   *  (e.g. chat's "Use default (…)" sentinel to revert an override). */
  extraOptions?: ExtraOption[];
  loading?: boolean;
  error?: string | null;
  placeholder?: string;
  onOpen?: () => void;
  /** "field" = full-width Settings/Onboarding row; "pill" = compact chat composer pill. */
  variant?: "field" | "pill";
  "aria-label"?: string;
}

export const ModelPicker = React.memo(function ModelPicker({
  value, onChange, models, unified = false, extraOptions = [], loading, error,
  placeholder, onOpen, variant = "field", "aria-label": ariaLabel,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const [pos, setPos] = useState<ReturnType<typeof computePopoverPos> | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => models.map((m) => toRow(m, unified)), [models, unified]);

  const sorted = useMemo(() => [...rows].sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    if (unified) {
      const p = (a.provider ?? "").localeCompare(b.provider ?? "");
      if (p !== 0) return p;
    }
    return a.id.localeCompare(b.id);
  }), [rows, unified]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((r) => r.id.toLowerCase().includes(q) || (r.provider ?? "").toLowerCase().includes(q));
  }, [sorted, query]);

  // Combined navigable list: pinned extra options first, then the filtered models.
  const items = useMemo(() => [
    ...extraOptions.map((e) => ({ isExtra: true as const, value: e.value, label: e.label })),
    ...filtered.map((row) => ({ isExtra: false as const, value: row.key, row })),
  ], [extraOptions, filtered]);

  const openPicker = useCallback(() => {
    if (!triggerRef.current) return;
    setPos(computePopoverPos(triggerRef.current, { minWidth: 400, maxHeight: 320 }));
    setQuery("");
    setFocusIdx(0);
    setOpen(true);
    onOpen?.();
  }, [onOpen]);

  const closePicker = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useClickOutside([triggerRef, popRef], closePicker, open);
  useEscapeKey(closePicker, open);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Re-clamp position if the window resizes while open (e.g. panel drag-resize).
  useEffect(() => {
    if (!open) return;
    const onResize = () => triggerRef.current && setPos(computePopoverPos(triggerRef.current, { minWidth: 400, maxHeight: 320 }));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  const select = useCallback((v: string) => { onChange(v); closePicker(); }, [onChange, closePicker]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, items.length - 1)); break;
      case "ArrowUp":   e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); break;
      case "Enter": {
        e.preventDefault();
        const item = items[focusIdx];
        if (item) select(item.value);
        break;
      }
      case "Escape": e.preventDefault(); closePicker(); break;
    }
  }, [items, focusIdx, select, closePicker]);

  // Selected summary for the closed trigger — a matched live row, a matched
  // extra option, or (for a saved value no longer in the live list) a
  // best-effort synthesized row so something meaningful still shows.
  const selectedExtra = extraOptions.find((e) => e.value === value);
  const selectedRow = rows.find((r) => r.key === value);
  const ghostId = !selectedExtra && !selectedRow && value ? (unified ? value.split("::")[1] ?? value : value) : null;
  // A non-default value while extraOptions exist means the user has overridden
  // the default for this one picker (chat's per-conversation override) — call
  // that out visually the same way the context pill highlights its "on" state.
  const isOverride = extraOptions.length > 0 && !selectedExtra;

  const triggerContent = selectedExtra ? (
    <span className="model-picker__id">{selectedExtra.label}</span>
  ) : selectedRow ? (
    <>
      <span className="model-picker__id">{selectedRow.id}</span>
      {variant === "field" && <RowBadges row={selectedRow} unified={unified} />}
    </>
  ) : ghostId ? (
    <span className="model-picker__id">{ghostId}</span>
  ) : (
    <span className="model-picker__placeholder">{loading ? "Loading…" : placeholder ?? "Select model"}</span>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`model-picker__trigger model-picker__trigger--${variant}${open ? " is-open" : ""}${isOverride ? " is-override" : ""}`}
        onClick={() => (open ? closePicker() : openPicker())}
      >
        {variant === "pill" && <Cpu size={11} className="model-picker__pill-icon" />}
        <span className="model-picker__trigger-content">{triggerContent}</span>
        <ChevronDown size={12} className="model-picker__chevron" />
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          className="model-picker__popover"
          role="listbox"
          aria-label={ariaLabel}
          style={{
            position: "fixed",
            left: pos.left,
            width: pos.width,
            top: pos.top,
            bottom: pos.bottom,
            maxHeight: 320,
          }}
          onKeyDown={handleKeyDown}
        >
          <div className="model-picker__search">
            <Search size={12} className="model-picker__search-icon" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setFocusIdx(0); }}
              placeholder="Search models…"
              aria-label="Search models"
              className="model-picker__search-input"
            />
          </div>

          <div className="model-picker__list">
            {loading && <div className="model-picker__empty">Loading models…</div>}
            {!loading && items.length === 0 && (
              <div className="model-picker__empty">{error ? error : query ? "No models match" : "No models available"}</div>
            )}
            {!loading && items.map((item, i) => {
              const isFocused = i === focusIdx;
              const isSelected = item.value === value;
              return (
                <div
                  key={item.value}
                  role="option"
                  aria-selected={isSelected}
                  className={`model-picker__row${isFocused ? " is-focused" : ""}${isSelected ? " is-selected" : ""}${item.isExtra ? " is-extra" : ""}`}
                  onMouseDown={(e) => { e.preventDefault(); select(item.value); }}
                  onMouseEnter={() => setFocusIdx(i)}
                >
                  {isSelected ? <Check size={13} className="model-picker__check" /> : <span className="model-picker__check-spacer" />}
                  {item.isExtra ? (
                    <span className="model-picker__id">{item.label}</span>
                  ) : (
                    <>
                      <span className="model-picker__id">{item.row.id}</span>
                      <RowBadges row={item.row} unified={unified} />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
});
