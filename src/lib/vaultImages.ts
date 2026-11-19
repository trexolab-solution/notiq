/**
 * Images inside Secure Vault notes.
 *
 * A pasted image in a vault note is stored as an encrypted attachment of that entry (never on disk)
 * and referenced from the markdown as `vault-attachment:<id>`. The preview turns the reference into
 * an object URL of the decrypted bytes, which only lives while something shows it.
 *
 * Everything here is pure (no Tauri calls) so it can be unit-tested; the loader is passed in.
 */

export const VAULT_IMAGE_SCHEME = "vault-attachment:";

/** Attachment ids are 16 random bytes as lowercase hex (src-tauri/src/vault_db.rs `new_id`). */
export const VAULT_ATTACHMENT_ID_RE = /^[0-9a-f]{32}$/;

/** `vault-attachment:<id>` for a valid id. */
export function formatVaultImageRef(id: string): string {
  if (!VAULT_ATTACHMENT_ID_RE.test(id)) throw new Error("Invalid attachment id");
  return `${VAULT_IMAGE_SCHEME}${id}`;
}

/** The markdown inserted for a pasted image. */
export function vaultImageMarkdown(id: string, alt = "pasted-image"): string {
  return `![${alt}](${formatVaultImageRef(id)})`;
}

/** True for any src that uses the scheme (valid or not), so callers never treat it as a file path. */
export function isVaultImageSrc(src: string): boolean {
  return src.slice(0, VAULT_IMAGE_SCHEME.length).toLowerCase() === VAULT_IMAGE_SCHEME;
}

/** The attachment id in a `vault-attachment:<id>` src, or null when it isn't one (or is malformed). */
export function parseVaultImageRef(src: string): string | null {
  if (!isVaultImageSrc(src)) return null;
  const id = src.slice(VAULT_IMAGE_SCHEME.length).trim();
  return VAULT_ATTACHMENT_ID_RE.test(id) ? id : null;
}

// ── Object URL cache ──────────────────────────────────────────────────────────
// Reference counted, so the same image shown twice (or remounted while typing) is decrypted once.
// The URL is revoked shortly after the last user lets go.

interface CacheEntry { refs: number; url: Promise<string>; timer?: ReturnType<typeof setTimeout> }

export interface VaultImageCacheDeps {
  load: (path: string, id: string) => Promise<Blob>;
  createUrl?: (b: Blob) => string;
  revokeUrl?: (url: string) => void;
  /** How long an unused URL is kept before it's revoked (ms). */
  revokeDelay?: number;
}

export function createVaultImageCache(deps: VaultImageCacheDeps) {
  const createUrl = deps.createUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = deps.revokeUrl ?? ((u: string) => URL.revokeObjectURL(u));
  const delay = deps.revokeDelay ?? 1500;
  const entries = new Map<string, CacheEntry>();
  const keyOf = (path: string, id: string) => `${path}\n${id}`;

  const drop = (key: string, e: CacheEntry) => {
    entries.delete(key);
    e.url.then(revokeUrl, () => { /* never created */ });
  };

  return {
    /** Resolves an object URL for the image; every call must be paired with `release`. */
    acquire(path: string, id: string): Promise<string> {
      const key = keyOf(path, id);
      let e = entries.get(key);
      if (e) {
        if (e.timer) { clearTimeout(e.timer); e.timer = undefined; }
        e.refs++;
        return e.url;
      }
      const url = deps.load(path, id).then(createUrl);
      e = { refs: 1, url };
      entries.set(key, e);
      // A failed load isn't cached: the next acquire retries (e.g. after unlocking).
      url.catch(() => { if (entries.get(key) === e) entries.delete(key); });
      return url;
    },
    release(path: string, id: string): void {
      const key = keyOf(path, id);
      const e = entries.get(key);
      if (!e) return;
      e.refs = Math.max(0, e.refs - 1);
      if (e.refs > 0 || e.timer) return;
      if (delay <= 0) { drop(key, e); return; }
      e.timer = setTimeout(() => { if (entries.get(key) === e && e.refs === 0) drop(key, e); }, delay);
    },
    /** Revokes everything now (e.g. when the vault locks). */
    clear(): void {
      for (const [key, e] of [...entries]) { if (e.timer) clearTimeout(e.timer); drop(key, e); }
    },
    size: () => entries.size,
  };
}

// ── Sweeping unreferenced pasted images ───────────────────────────────────────

/** Ids of every `vault-attachment:<id>` mentioned anywhere in `text` (markdown or HTML image forms). Deliberately broad: over-counting only keeps an attachment. */
export function referencedVaultImageIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/vault-attachment:\s*([0-9a-f]{32})(?![0-9a-f])/gi)) ids.add(m[1].toLowerCase());
  return ids;
}

/** Name given to a pasted vault image by `nextImageFilename` (`img-N.ext`). */
export const PASTED_IMAGE_NAME_RE = /^img-\d+\.[a-z0-9]+$/i;

/** Attachments added more recently than this are never swept (a paste may not be in the saved text yet). */
export const SWEEP_GRACE_MS = 30_000;

/**
 * Attachment ids that are safe to delete: pasted images (by name) that no text in `texts` refers to.
 * `texts` must include the note being saved plus every retained history version, so restoring an
 * older version keeps its images. When `textReliable` is false nothing is selected.
 */
export function unreferencedPastedImages(
  attachments: { id: string; name: string; added: number }[],
  texts: string[],
  textReliable: boolean,
  now = Date.now(),
): string[] {
  if (!textReliable) return [];
  const keep = new Set<string>();
  for (const t of texts) for (const id of referencedVaultImageIds(t)) keep.add(id);
  return attachments
    .filter((a) => PASTED_IMAGE_NAME_RE.test(a.name) && !keep.has(a.id.toLowerCase()) && now - a.added >= SWEEP_GRACE_MS)
    .map((a) => a.id);
}
