import type { GraphData, Tab } from "../types";
import { normNote, fileBasename } from "./resolveNote";

// Standard markdown links: [display text](url or note title)
const MD_LINK_RE = /\[([^\]]+)\]\(([^)\s]+(?:\s[^)]+)?)\)/g;

// Wiki-links: [[Title]] or [[Title|alias]]
const WIKI_LINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;

export function buildGraphData(tabs: Tab[]): GraphData {
  const nodes = tabs.map((t) => ({
    id:    t.id,
    name:  t.title,
    tabId: t.id,
    val:   3,
  }));

  // ── Lookup maps ──────────────────────────────────────────────────────────────
  // Map 1 — normalised title → id  (in-memory notes, plain "[text](Note Title)" links)
  const titleMap = new Map<string, string>(
    tabs.map((t) => [normNote(t.title), t.id]),
  );

  // Map 2 — normalised filename of the tab's filePath → id
  //   handles links like  [text](subfolder/note.md)  →  basename "note.md"  →  "note"
  //   First match wins so duplicate filenames don't silently clobber each other.
  const fileNameMap = new Map<string, string>();
  for (const t of tabs) {
    if (!t.filePath) continue;
    const key = normNote(fileBasename(t.filePath));
    if (!fileNameMap.has(key)) fileNameMap.set(key, t.id);
  }

  // ── Resolution logic ─────────────────────────────────────────────────────────
  const resolve = (raw: string): string | undefined => {
    // 1. Exact normalised match against title map
    //    Catches: "Note Title", "note-title", "note_title", "note title"
    let id = titleMap.get(normNote(raw));
    if (id) return id;

    // 2. Basename of the link target matched against title map
    //    Catches: "subfolder/note-title.md"  →  basename "note-title.md"  →  "note title"
    const bname = fileBasename(raw);
    if (bname !== raw) {
      id = titleMap.get(normNote(bname));
      if (id) return id;
    }

    // 3. Basename matched against the filename map
    //    Catches: path references to files that were opened from disk
    id = fileNameMap.get(normNote(bname));
    return id;
  };

  const seen  = new Set<string>();
  const links: GraphData["links"] = [];

  const push = (src: string, tgt: string) => {
    if (tgt === src) return;
    const key = [src, tgt].sort().join(":");
    if (!seen.has(key)) { seen.add(key); links.push({ source: src, target: tgt }); }
  };

  for (const tab of tabs) {
    // Standard markdown links  [text](target)
    for (const m of tab.content.matchAll(MD_LINK_RE)) {
      const id = resolve(m[2]);
      if (id) push(tab.id, id);
    }
    // Wiki-links  [[Title]] or [[Title|alias]]
    for (const m of tab.content.matchAll(WIKI_LINK_RE)) {
      const id = resolve(m[1]);
      if (id) push(tab.id, id);
    }
  }

  return { nodes, links };
}
