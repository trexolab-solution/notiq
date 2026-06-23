// Lightweight, dependency-free heuristic to estimate how relevant the active
// note/file is to the user's chat message. Used to (a) label the context pill
// honestly and (b) tell the model whether to lean on the note or ignore it.

export type Relevance = "high" | "medium" | "low";

// Words that explicitly point at the open document.
const REFERENTIAL = /\b(this|that|these|those|here|above|below|it|its|the (?:note|file|code|doc|document|page|snippet|text|selection))\b/i;
const EDIT_VERBS = /\b(fix|complete|continue|edit|change|update|refactor|improve|rewrite|explain|summari[sz]e|translate|debug|add to|remove from|convert)\b/i;

const STOP = new Set([
  "the","a","an","and","or","but","to","of","in","on","for","with","is","are","be",
  "this","that","it","i","you","me","my","we","do","can","please","make","write","create",
]);

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

/**
 * Score the message against the note content. Combines explicit referential
 * phrasing with keyword overlap. Returns a coarse bucket the UI + prompt use.
 */
export function scoreRelevance(message: string, noteContent: string): Relevance {
  const msg = message.trim();
  if (!msg || !noteContent.trim()) return "low";

  // Explicit pointers ("fix this", "the code", "explain it") → strong signal.
  const referential = REFERENTIAL.test(msg) || EDIT_VERBS.test(msg);

  // Keyword overlap between the message and the note.
  const mTok = tokens(msg);
  const nTok = tokens(noteContent);
  let shared = 0;
  for (const w of mTok) if (nTok.has(w)) shared++;
  const overlap = mTok.size > 0 ? shared / mTok.size : 0;

  if (referential || overlap >= 0.5) return "high";
  if (overlap >= 0.2 || shared >= 2) return "medium";
  return "low";
}

/** Human label + tone for the context pill. */
export function relevanceLabel(r: Relevance): string {
  return r === "high" ? "Relevant" : r === "medium" ? "Loosely related" : "Probably unrelated";
}
