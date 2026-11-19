import { vaultAttachList, vaultAttachRemove, vaultHistoryGet, vaultHistoryList } from "./vault";
import { unreferencedPastedImages } from "./vaultImages";

/**
 * Best-effort cleanup after a Secure note is saved: removes pasted-image attachments that neither the
 * saved text nor any retained history version refers to. Never throws; any failure just skips the sweep
 * (including a history version that can't be read, since then we can't tell what is still referenced).
 */
export async function sweepUnusedVaultImages(path: string, savedContent: string): Promise<void> {
  try {
    const attachments = await vaultAttachList(path);
    if (!attachments.length) return;
    const revs = await vaultHistoryList(path);
    const texts = [savedContent];
    for (const r of revs) texts.push((await vaultHistoryGet(path, r.index)).content);
    for (const id of unreferencedPastedImages(attachments, texts, true)) await vaultAttachRemove(path, id);
  } catch (e) {
    console.warn("vault image sweep skipped", e);
  }
}
