/**
 * Vault changes the UI holds back for a few seconds so they can be undone (e.g. removing an attachment
 * waits until its Undo toast expires). Anything that is about to lock the vault calls
 * {@link flushVaultPendingOps} first so those changes are applied while the vault is still open.
 */

type Flush = () => Promise<void>;
const flushers = new Set<Flush>();

/** Adds a flush function; returns the unregister function. */
export function registerVaultFlush(fn: Flush): () => void {
  flushers.add(fn);
  return () => { flushers.delete(fn); };
}

/** Runs every registered flush; a failing one doesn't stop the others. */
export async function flushVaultPendingOps(): Promise<void> {
  await Promise.allSettled([...flushers].map((f) => f()));
}
