import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Info, Search, X } from "lucide-react";
import { Avatar } from "../ui/Avatar";
import { Tooltip } from "../ui/Tooltip";
import { DialogCheckbox } from "../ui/DialogParts";
import { useAnnouncer } from "../../hooks/useAnnouncer";
import {
  cardTitle, identityTitle, loginLastUsed, type CardMatch, type IdentityMatch, type LoginMatch,
} from "../../lib/autofill";
import { cardBrand, cardExpired, maskCardNumber } from "../../lib/cardEntry";
import { identitySummary } from "../../lib/identityEntry";
import { COPY_LABEL, type ApprovedCopy } from "../../lib/autofillPopup";

/**
 * The pickers of the browser-autofill prompts (which login, card, identity or passkey), shared by the
 * small autofill window (src/autofill/) and the main-window fallback dialog (AutofillPrompt.tsx).
 * Re-exported from ./autofillBodies.
 */

// ── Choice list ─────────────────────────────────────────────────────────────

export interface ChoiceBadge {
  label: string;
  tone?: "neutral" | "primary" | "danger";
  /** Tooltip / longer wording. */
  title?: string;
}

/** One row of a {@link ChoiceList}. `value` is what `pick` / `onPick` use (an index; -1 for "New login"). */
export interface ChoiceItem {
  value: number;
  key: string;
  title: string;
  sub: ReactNode;
  /** Name the letter avatar is drawn from (usually the title). */
  avatar: string;
  /** Replaces the letter (e.g. a "+" for "New login"). */
  icon?: ReactNode;
  badges?: ChoiceBadge[];
  /** Text the search box matches; defaults to the title. */
  search?: string;
}

/** Above this many rows the list gets a search box. */
export const SEARCH_THRESHOLD = 5;
export const showsSearch = (rows: number) => rows > SEARCH_THRESHOLD;

/** Indexes of the texts containing every word of `query` (case-insensitive), in their original order. */
export function filterChoices(texts: readonly string[], query: string): number[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out: number[] = [];
  texts.forEach((t, i) => { const s = t.toLowerCase(); if (words.every((w) => s.includes(w))) out.push(i); });
  return out;
}

/** The rows a search leaves on screen (all of them for an empty query). */
export function visibleChoices(items: readonly ChoiceItem[], query: string): ChoiceItem[] {
  if (!query.trim()) return [...items];
  return filterChoices(items.map((i) => i.search ?? i.title), query).map((i) => items[i]);
}

export interface ChoiceListProps {
  /** Accessible name of the radio group ("Saved logins"). */
  label: string;
  /** Plural noun for the search box and its messages ("logins"). */
  noun: string;
  items: ChoiceItem[];
  pick: number;
  onPick: (value: number) => void;
  /** Enter on a row, or a double-click: the caller picks that row and allows. */
  onAllow?: (value: number) => void;
  /** Opens the read-only details view of a row (the autofill window only). */
  onDetails?: (value: number) => void;
  disabled?: boolean;
  /** Search text; the box is shown when `onQuery` is given and there are more than {@link SEARCH_THRESHOLD} rows. */
  query?: string;
  onQuery?: (query: string) => void;
}

/**
 * The radio group every prompt picks from: one row per entry (letter avatar, bold title, muted second
 * line, small badges), the whole row clickable. Keyboard: ↑ / ↓ move the selection (also when pressed on
 * the footer buttons, which is where the focus starts), Home / End jump, Enter allows the focused row and
 * a double-click allows the clicked one. Escape belongs to the window (Deny), except in a search box with
 * text in it, where it clears the search first.
 *
 * Enter in the search box only moves the focus to the selected row: a stray Enter while the window pops
 * up must never release anything (the window opens with Deny focused for the same reason).
 *
 * The details button sits beside the radio, not inside it, so pressing it neither picks the row nor
 * fills anything. It is shown on hover, on focus and on the selected row, and the selected row's button
 * is the list's one extra Tab stop.
 */
export function ChoiceList({ label, noun, items, pick, onPick, onAllow, onDetails, disabled, query = "", onQuery }: ChoiceListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const searchable = !!onQuery && showsSearch(items.length);
  const q = searchable ? query : "";
  const visible = visibleChoices(items, q);
  const pickVisible = visible.some((i) => i.value === pick);
  const focusValue = pickVisible ? pick : visible[0]?.value;
  const { announce, region } = useAnnouncer();

  // The search hid the selected row: select the first one left, so Allow always fills a row on screen.
  const firstVisible = visible[0]?.value;
  useEffect(() => {
    if (q && !pickVisible && firstVisible !== undefined && !disabled) onPick(firstVisible);
  }, [q, pickVisible, firstVisible, disabled, onPick]);

  const announced = useRef(q);
  useEffect(() => {
    if (announced.current === q) return;
    announced.current = q;
    announce(!q ? `${items.length} ${noun}` : visible.length ? `${visible.length} of ${items.length} ${noun}` : `No ${noun} match`);
  }, [q, visible.length, items.length, noun, announce]);

  const focusRow = (value: number | undefined) => {
    if (value !== undefined) listRef.current?.querySelector<HTMLElement>(`[data-choice="${value}"]`)?.focus();
  };
  /** Moves the selection within the visible rows (wrapping) and returns the new value. */
  const move = (to: "next" | "prev" | "first" | "last"): number | undefined => {
    if (disabled || !visible.length) return undefined;
    const at = visible.findIndex((i) => i.value === pick);
    const n = visible.length;
    const idx = to === "first" ? 0 : to === "last" ? n - 1
      : at < 0 ? 0 : to === "next" ? (at + 1) % n : (at - 1 + n) % n;
    const v = visible[idx].value;
    if (v !== pick) onPick(v);
    return v;
  };
  const allow = (value: number) => {
    if (disabled || !onAllow) return;
    if (value !== pick) onPick(value);
    onAllow(value);
  };

  const onRowKey = (e: KeyboardEvent, value: number) => {
    const to = e.key === "ArrowDown" || e.key === "ArrowRight" ? "next"
      : e.key === "ArrowUp" || e.key === "ArrowLeft" ? "prev"
      : e.key === "Home" ? "first" : e.key === "End" ? "last" : null;
    if (to) { e.preventDefault(); focusRow(move(to)); return; }
    if (e.key === "Enter" && onAllow) { e.preventDefault(); allow(value); return; }
    if (e.key === " ") { e.preventDefault(); if (!disabled) onPick(value); }
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); move(e.key === "ArrowDown" ? "next" : "prev"); return; }
    if (e.key === "Enter") { e.preventDefault(); focusRow(focusValue); return; }
    if (e.key === "Escape" && q) { e.preventDefault(); e.stopPropagation(); onQuery?.(""); }
  };

  // ↑ / ↓ pressed elsewhere in the same window (e.g. on Deny, which has the focus at first): go to the list.
  const latest = useRef({ focusValue, disabled });
  latest.current = { focusValue, disabled };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.defaultPrevented || latest.current.disabled) return;
      const list = listRef.current;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (!list || (t && list.contains(t))) return;
      if (t?.closest("input, textarea, select, [role=combobox], [role=listbox], [role=menu]")) return;
      const scope = list.closest("[role=alertdialog], [role=dialog]");
      if (scope && t && t !== document.body && !scope.contains(t)) return;
      e.preventDefault();
      const v = latest.current.focusValue;
      if (v !== undefined) list.querySelector<HTMLElement>(`[data-choice="${v}"]`)?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="af-choices">
      {searchable && (
        <div className="af-search">
          <Search size={14} aria-hidden className="af-search-icon" />
          <input type="text" autoFocus data-autofocus="" spellCheck={false} autoComplete="off"
                 aria-label={`Search ${noun}`} placeholder={`Search ${items.length} ${noun}…`}
                 value={query} disabled={disabled}
                 onChange={(e) => onQuery?.(e.target.value)} onKeyDown={onSearchKey} />
          {query && (
            <button type="button" className="af-search-clear" aria-label="Clear search" tabIndex={-1}
                    onClick={() => onQuery?.("")}>
              <X size={12} aria-hidden />
            </button>
          )}
          {region}
        </div>
      )}
      <div ref={listRef} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className="af-rows">
        {visible.map((item) => {
          const sel = item.value === pick;
          const stop = item.value === focusValue;
          return (
            <div key={item.key} className="af-row" data-selected={sel ? "" : undefined}>
              <div role="radio" aria-checked={sel} aria-disabled={disabled || undefined} tabIndex={stop ? 0 : -1}
                   data-choice={item.value} className="af-row-main"
                   onClick={() => { if (!disabled) onPick(item.value); }}
                   onDoubleClick={() => allow(item.value)}
                   onKeyDown={(e) => onRowKey(e, item.value)}>
                {item.icon
                  ? <span aria-hidden className="nq-avatar nq-avatar--muted" style={{ width: 30, height: 30 }}>{item.icon}</span>
                  : <Avatar name={item.avatar} size={30} />}
                <span className="af-row-text">
                  <span className="af-row-title">{item.title}</span>
                  <span className="af-row-sub">{item.sub}</span>
                </span>
                {!!item.badges?.length && (
                  <span className="af-badges">
                    {item.badges.map((b) => (
                      <span key={b.label} className={`af-badge af-badge--${b.tone ?? "neutral"}`} title={b.title}>{b.label}</span>
                    ))}
                  </span>
                )}
              </div>
              {onDetails && (
                <Tooltip content="View details">
                  <button type="button" className="af-details-btn" aria-label={`View details of ${item.title || "this entry"}`}
                          data-af-details={item.value} tabIndex={stop ? 0 : -1} disabled={disabled}
                          onDoubleClick={(e) => e.stopPropagation()}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDetails(item.value); }}>
                    <Info size={15} aria-hidden />
                  </button>
                </Tooltip>
              )}
            </div>
          );
        })}
      </div>
      {searchable && q && !visible.length && (
        <div className="af-empty">
          <Search size={16} aria-hidden />
          <span>No {noun} match &ldquo;{q.trim()}&rdquo;.</span>
          <button type="button" className="af-link-btn" onClick={() => onQuery?.("")}>Clear search</button>
        </div>
      )}
    </div>
  );
}

// ── Logins ──────────────────────────────────────────────────────────────────

const noUser = <span className="af-muted-i">(no username)</span>;

/** Rows for saved logins: "Last used" on the most recently filled one (when there is a choice), "2FA", "Passkey". */
export function loginChoiceItems(matches: LoginMatch[], lastUsedOf: (m: LoginMatch) => number = loginLastUsed): ChoiceItem[] {
  let recent = -1;
  let best = 0;
  matches.forEach((m, i) => { const t = lastUsedOf(m); if (t > best) { best = t; recent = i; } });
  return matches.map((m, i) => {
    const title = m.entry.title || m.entry.url;
    const badges: ChoiceBadge[] = [];
    if (i === recent && matches.length > 1) badges.push({ label: "Last used", tone: "primary", title: "Filled most recently" });
    if (m.entry.totp.trim()) badges.push({ label: "2FA", title: "Has a 2-step code" });
    if (m.entry.passkeys?.length) badges.push({ label: "Passkey", title: "Has a passkey" });
    return {
      value: i, key: m.path, title, avatar: title, badges,
      sub: m.entry.username || noUser,
      search: [m.entry.title, m.entry.username, m.entry.url, ...(m.entry.urls ?? [])].join(" "),
    };
  });
}

/** Primary button text for a login request: "Fill as alex.morgan", "Fill code for alex.morgan", "Copy password". */
export function fillAllowLabel(m: LoginMatch | undefined, req: { copy?: ApprovedCopy; intent?: string }): string {
  if (req.copy) return `Copy ${COPY_LABEL[req.copy]}`;
  if (!m) return "Allow";
  const who = m.entry.username.trim();
  const title = (m.entry.title || m.entry.url).trim();
  const name = who || title;
  if (req.intent === "code") return name ? `Fill code for ${name}` : "Fill code";
  return who ? `Fill as ${who}` : title ? `Fill ${title}` : "Fill";
}

export interface FillChoiceProps {
  host: string;
  matches: LoginMatch[];
  pick: number;
  onPick: (index: number) => void;
  trust: boolean;
  onTrust: (on: boolean) => void;
  disabled?: boolean;
  /** Opens the read-only details view of row `index` (the autofill window only). */
  onDetails?: (index: number) => void;
  /** Enter / double-click on a row: pick it and allow. */
  onAllow?: (index: number) => void;
  query?: string;
  onQuery?: (query: string) => void;
  /** Test seam: when each login was last filled. */
  lastUsedOf?: (m: LoginMatch) => number;
}

/** Which saved login to send, plus "Don't ask again on this site for 5 minutes". */
export function FillChoice({
  host, matches, pick, onPick, trust, onTrust, disabled, onDetails, onAllow, query, onQuery, lastUsedOf,
}: FillChoiceProps) {
  return (
    <>
      <ChoiceList label="Saved logins" noun="logins" items={loginChoiceItems(matches, lastUsedOf)} pick={pick} onPick={onPick}
                  onAllow={onAllow} onDetails={onDetails} disabled={disabled} query={query} onQuery={onQuery} />
      <div className="af-trust-opt" data-on={trust ? "" : undefined}>
        <DialogCheckbox
          checked={trust}
          onChange={onTrust}
          label={<>Don&rsquo;t ask again on <strong className="af-host-inline">{host}</strong> for 5 minutes</>}
          hint="Only this exact site, and only while the vault stays unlocked."
        />
      </div>
    </>
  );
}

// ── Cards ───────────────────────────────────────────────────────────────────

/** Rows for saved cards: title, brand, masked number and expiry (never the full number or the CVC). */
export function cardChoiceItems(cards: CardMatch[]): ChoiceItem[] {
  return cards.map((c, i) => {
    const brand = cardBrand(c.fill.number);
    const exp = c.fill.exp_month ? `${c.fill.exp_month}/${c.fill.exp_year.slice(-2)}` : "";
    const title = cardTitle(c);
    return {
      value: i, key: c.path, title, avatar: title,
      sub: [brand, maskCardNumber(c.fill.number), exp && `exp ${exp}`].filter(Boolean).join(" · "),
      badges: cardExpired(c.fill) ? [{ label: "Expired", tone: "danger" as const, title: `Expired ${exp}` }] : [],
      search: [title, brand, c.fill.name, c.fill.number.replace(/\D/g, "").slice(-4)].filter(Boolean).join(" "),
    };
  });
}

export const cardAllowLabel = (c: CardMatch | undefined) => (c ? `Fill ${cardTitle(c)}` : "Fill card");

export interface CardChoiceProps {
  cards: CardMatch[];
  pick: number;
  onPick: (index: number) => void;
  disabled?: boolean;
  onDetails?: (index: number) => void;
  onAllow?: (index: number) => void;
  query?: string;
  onQuery?: (query: string) => void;
}

/** Which saved card to send. */
export function CardChoice({ cards, pick, onPick, disabled, onDetails, onAllow, query, onQuery }: CardChoiceProps) {
  return (
    <ChoiceList label="Saved cards" noun="cards" items={cardChoiceItems(cards)} pick={pick} onPick={onPick}
                onAllow={onAllow} onDetails={onDetails} disabled={disabled} query={query} onQuery={onQuery} />
  );
}

// ── Identities ──────────────────────────────────────────────────────────────

/** Rows for saved identities: the title plus name and city (the rest is only sent once allowed). */
export function identityChoiceItems(identities: IdentityMatch[]): ChoiceItem[] {
  return identities.map((m, i) => {
    const title = identityTitle(m);
    const summary = identitySummary(m.fill);
    return {
      value: i, key: m.path, title, avatar: title,
      sub: summary || <span className="af-muted-i">(no name)</span>,
      search: [title, summary].join(" "),
    };
  });
}

export const identityAllowLabel = (m: IdentityMatch | undefined) => (m ? `Fill ${identityTitle(m)}` : "Fill");

export interface IdentityChoiceProps {
  identities: IdentityMatch[];
  pick: number;
  onPick: (index: number) => void;
  disabled?: boolean;
  onDetails?: (index: number) => void;
  onAllow?: (index: number) => void;
  query?: string;
  onQuery?: (query: string) => void;
}

/** Which saved identity to send. */
export function IdentityChoice({ identities, pick, onPick, disabled, onDetails, onAllow, query, onQuery }: IdentityChoiceProps) {
  return (
    <ChoiceList label="Saved identities" noun="identities" items={identityChoiceItems(identities)} pick={pick} onPick={onPick}
                onAllow={onAllow} onDetails={onDetails} disabled={disabled} query={query} onQuery={onQuery} />
  );
}
