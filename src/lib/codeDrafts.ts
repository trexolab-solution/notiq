/**
 * Recovery codes typed or pasted into an entry's box but not added to its list yet. Save adds them first, so
 * pressing Save without "Add codes" never loses them. Held in memory only (they are secrets): never persisted,
 * and dropped when the tab closes or the vault locks.
 */
import { addCodes, CODES_EXT, parseCodes, serializeCodes, splitCodes, type RecoveryCode } from "./recoveryCodes";
import { LOGIN_EXT, parseLogin, serializeLogin } from "./loginEntry";

const drafts = new Map<string, string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const getCodeDraft = (tabId: string): string => drafts.get(tabId) ?? "";
export const hasCodeDraft = (tabId: string): boolean => getCodeDraft(tabId).trim() !== "";

export function setCodeDraft(tabId: string, text: string): void {
  if (text) drafts.set(tabId, text);
  else drafts.delete(tabId);
  emit();
}

export function clearAllCodeDrafts(): void {
  drafts.clear();
  emit();
}

export function subscribeCodeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * `content` with the codes in `draft` added to its list, plus the codes that didn't fit (the list is full).
 * Duplicates are simply dropped. Entry types without a code list come back unchanged.
 */
export function applyCodeDraft(ext: string, content: string, draft: string): { content: string; leftover: string[] } {
  const merge = (list: RecoveryCode[]) => {
    const r = addCodes(list, draft);
    const have = new Set(r.codes.map((c) => c.code.toLowerCase()));
    return { ...r, leftover: splitCodes(draft).filter((c) => !have.has(c.toLowerCase())) };
  };
  if (ext === CODES_EXT) {
    const e = parseCodes(content);
    const r = merge(e.codes);
    return { content: r.added ? serializeCodes({ ...e, codes: r.codes }) : content, leftover: r.leftover };
  }
  if (ext === LOGIN_EXT) {
    const e = parseLogin(content);
    const r = merge(e.recovery ?? []);
    return { content: r.added ? serializeLogin({ ...e, recovery: r.codes }) : content, leftover: r.leftover };
  }
  return { content, leftover: [] };
}
