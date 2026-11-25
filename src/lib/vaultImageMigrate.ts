import { formatVaultImageRef } from "./vaultImages";

/**
 * Locking a plain note into the vault: its images are files on disk (`assets/img-1.png` next to the note, or a
 * temp folder for an unsaved one), which a vault note can't reach. They are moved into the entry as encrypted
 * attachments and the links rewritten to `vault-attachment:<id>`, the same form a pasted image has in a vault note.
 *
 * Pure apart from the three callbacks, so it can be tested without Tauri.
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const isRemote = (s: string) => !/^[A-Za-z]:[\\/]/.test(s) && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(s); // http:, data:, blob:, vault-attachment:, … (not "C:/…")
const FENCE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g;
const IMAGE_MD = /!\[([^\]]*)\]\(\s*(<[^>\n]+>|[^)\s]+)((?:\s+(?:"[^"]*"|'[^']*'))?)\s*\)/g;

export interface MigrateDeps {
  /** The file a link points at (absolute path), or null when it can't be found. */
  resolve: (src: string) => string | null;
  /** The file's bytes; throws when it can't be read. */
  load: (abs: string) => Promise<Uint8Array>;
  /** Stores the bytes as an attachment of the entry and returns its id; throws an Error with a reason to show. */
  add: (name: string, bytes: Uint8Array) => Promise<string>;
}

export interface MigrateResult {
  content: string;
  /** Links now pointing at an attachment. */
  moved: number;
  /** Links left as they were, with why. */
  failed: { src: string; reason: string }[];
}

const nameOf = (abs: string) => abs.split(/[\\/]/).pop() || "image";
const unwrap = (raw: string) => (raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw);
const decode = (s: string) => { try { return decodeURI(s); } catch { return s; } };

/** Moves the local images of `content` into the entry; links that can't be moved stay as they were. */
export async function migrateLocalImages(content: string, deps: MigrateDeps): Promise<MigrateResult> {
  // Code blocks show markdown, they don't use it: leave them alone.
  const parts: { text: string; code: boolean }[] = [];
  let last = 0;
  for (const m of content.matchAll(FENCE)) {
    const at = m.index ?? 0;
    parts.push({ text: content.slice(last, at), code: false }, { text: m[0], code: true });
    last = at + m[0].length;
  }
  parts.push({ text: content.slice(last), code: false });

  const ids = new Map<string, string>();      // abs path -> attachment id (one file linked twice is stored once)
  const problems = new Map<string, string>(); // abs path -> reason
  const failed: { src: string; reason: string }[] = [];
  let moved = 0;

  const attach = async (src: string): Promise<string | null> => {
    const wanted = decode(unwrap(src));
    if (isRemote(wanted) || !IMAGE_EXT.test(wanted.split(/[?#]/)[0])) return null; // not a local image link
    const abs = deps.resolve(wanted);
    if (!abs) { failed.push({ src: wanted, reason: "The file couldn't be found" }); return null; }
    const known = ids.get(abs);
    if (known) return known;
    const bad = problems.get(abs);
    if (bad) { failed.push({ src: wanted, reason: bad }); return null; }
    try {
      const id = await deps.add(nameOf(abs), await deps.load(abs));
      ids.set(abs, id);
      return id;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      problems.set(abs, reason);
      failed.push({ src: wanted, reason });
      return null;
    }
  };

  let out = "";
  for (const p of parts) {
    if (p.code || !p.text) { out += p.text; continue; }
    let at = 0;
    for (const m of p.text.matchAll(IMAGE_MD)) {
      const start = m.index ?? 0;
      out += p.text.slice(at, start);
      at = start + m[0].length;
      const id = await attach(m[2]);
      if (id) { out += `![${m[1]}](${formatVaultImageRef(id)}${m[3] ?? ""})`; moved++; } else out += m[0];
    }
    out += p.text.slice(at);
  }
  return { content: out, moved, failed };
}
