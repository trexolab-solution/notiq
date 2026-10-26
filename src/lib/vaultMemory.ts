/**
 * Secure Vault — best-effort scrubbing of decrypted text from in-memory caches.
 *
 * Monaco keeps one text model per tab (path = tabId) and does NOT drop it when
 * you switch away, so after "Lock Vault" a background tab's plaintext would still
 * sit in the model registry. Disposing those models removes the text (and its
 * undo history) from memory. Monaco is imported lazily to keep this module cheap
 * for the store and unit tests.
 */
export async function scrubMonacoModels(tabIds: string[]): Promise<void> {
  if (tabIds.length === 0) return;
  try {
    const monaco = await import("monaco-editor");
    for (const model of monaco.editor.getModels()) {
      const uri = model.uri.toString();
      if (tabIds.some((id) => uri.includes(id))) model.dispose();
    }
  } catch (e) {
    console.warn("vault: couldn't scrub editor models", e);
  }
}
