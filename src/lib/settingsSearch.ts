import { SECTION_LABELS, SECTION_ORDER, type SectionId, type SettingMeta } from "./settingsIndex";
import { matchesQuery, queryTokens } from "../components/settings/settingsFilter";

/** Normalised, single-spaced text (same folding as the Settings filter: case + accents). */
const fold = (s: string) => queryTokens(s).join(" ");

/** Lower is better. Only called for settings that already match. */
function rank(meta: SettingMeta, phrase: string, tokens: string[]): number {
  const label = fold(meta.label);
  if (label.startsWith(phrase)) return 0;
  if (label.includes(phrase)) return 1;
  if (tokens.every((t) => label.includes(t))) return 2;
  return 3; // matched through description / keywords / section / group
}

/** Does this setting match the query? Section is matched by its label ("Appearance"), not its id. */
export function settingMatches(meta: SettingMeta, query: string): boolean {
  return matchesQuery(query, {
    label: meta.label, description: meta.description, keywords: meta.keywords,
    section: SECTION_LABELS[meta.section], group: meta.group,
  });
}

/** Matches per section for `query` (every section present, 0 when none match). */
export function sectionMatchCounts(items: SettingMeta[], query: string): Record<SectionId, number> {
  const counts = Object.fromEntries(SECTION_ORDER.map((id) => [id, 0])) as Record<SectionId, number>;
  for (const m of items) if (settingMatches(m, query)) counts[m.section]++;
  return counts;
}

/**
 * Which sections the Settings page shows for `query`. Empty query → all. Otherwise a section is shown when
 * one of its indexed settings matches; a section with no indexed settings at all is kept (its rows still
 * filter themselves), since the index can't tell whether it has a match.
 */
export function visibleSections(items: SettingMeta[], query: string): Set<SectionId> {
  if (!queryTokens(query).length) return new Set(SECTION_ORDER);
  const counts = sectionMatchCounts(items, query);
  const indexed = new Set(items.map((m) => m.section));
  return new Set(SECTION_ORDER.filter((id) => counts[id] > 0 || !indexed.has(id)));
}

/**
 * Ranks `items` against `query`: label starts with the query > label contains it > every word in the label >
 * description / keywords / section / group. Ties keep section order, then the order within `items`.
 * An empty query returns nothing.
 */
export function rankSettings(items: SettingMeta[], query: string, limit = Infinity): SettingMeta[] {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const phrase = tokens.join(" ");
  const order = (m: SettingMeta) => SECTION_ORDER.indexOf(m.section);
  return items
    .map((meta, i) => ({ meta, i }))
    .filter(({ meta }) => settingMatches(meta, query))
    .map(({ meta, i }) => ({ meta, i, r: rank(meta, phrase, tokens) }))
    .sort((a, b) => a.r - b.r || order(a.meta) - order(b.meta) || a.i - b.i)
    .slice(0, limit)
    .map(({ meta }) => meta);
}
