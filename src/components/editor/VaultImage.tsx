import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { ImageOff } from "lucide-react";
import { base64ToBytes, vaultAttachGet, vaultAttachList } from "../../lib/vault";
import { createVaultImageCache } from "../../lib/vaultImages";
import { useVaultStore } from "../../store/vaultStore";

/** Decrypts an image attachment of a vault entry into a Blob (in memory only). */
async function loadVaultImage(path: string, id: string): Promise<Blob> {
  const meta = (await vaultAttachList(path)).find((a) => a.id === id);
  if (!meta) throw new Error("That image is no longer attached to this note");
  if (!meta.mime.startsWith("image/")) throw new Error("That attachment isn't an image");
  const bytes = base64ToBytes(await vaultAttachGet(path, id));
  return new Blob([bytes as BlobPart], { type: meta.mime });
}

const cache = createVaultImageCache({ load: loadVaultImage });

// Locking the vault drops every decrypted image right away.
useVaultStore.subscribe((s, prev) => { if (prev.unlocked && !s.unlocked) cache.clear(); });

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { path: string; attachmentId: string };

/**
 * An image stored encrypted in the vault (`vault-attachment:<id>` in the markdown). Shown through an
 * object URL that is released on unmount. While loading it renders a placeholder marked
 * `data-vault-image-pending`, which PDF export waits for.
 */
export function VaultImage({ path, attachmentId, alt, ...props }: Props) {
  const [state, setState] = useState<{ url?: string; error?: string }>({});

  useEffect(() => {
    let live = true;
    setState({});
    cache.acquire(path, attachmentId).then(
      (url) => { if (live) setState({ url }); },
      (e: unknown) => { if (live) setState({ error: e instanceof Error ? e.message : "Couldn't open this image" }); },
    );
    return () => { live = false; cache.release(path, attachmentId); };
  }, [path, attachmentId]);

  if (state.url) return <img src={state.url} alt={alt ?? ""} {...props} />;
  return (
    <span data-vault-image-pending={state.error ? undefined : ""}
          title={state.error}
          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)]">
      {state.error && <ImageOff size={13} aria-hidden />}
      {state.error ?? "Decrypting image…"}
    </span>
  );
}
