import { createContext, useContext } from "react";

/** The Settings search box text. Rows read it and hide themselves when they don't match. */
export const SettingsQueryContext = createContext<string>("");
export const useSettingsQuery = () => useContext(SettingsQueryContext);

export interface Searchable {
  label?: string;
  description?: string;
  keywords?: string[];
  section?: string;
  group?: string;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

export function queryTokens(query: string): string[] {
  return norm(query).split(/\s+/).filter(Boolean);
}

/** True when the query is empty or every word of it appears somewhere in the setting's text. */
export function matchesQuery(query: string, f: Searchable): boolean {
  const tokens = queryTokens(query);
  if (!tokens.length) return true;
  const hay = norm([f.label, f.description, f.section, f.group, ...(f.keywords ?? [])].filter(Boolean).join(" "));
  return tokens.every((t) => hay.includes(t));
}
