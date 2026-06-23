/** Clipboard / Blob / naming helpers for the paste-image feature. */

import type * as monaco from "monaco-editor";
import { useAppStore } from "../store";
import { writeAssetNextToNote, writeTempImage } from "./attachments";

const MIME_TO_EXT: Record<string, string> = {
  "image/png":     "png",
  "image/jpeg":    "jpg",
  "image/jpg":     "jpg",
  "image/gif":     "gif",
  "image/webp":    "webp",
  "image/bmp":     "bmp",
  "image/svg+xml": "svg",
};

export function extFromMime(mime: string): string {
  return MIME_TO_EXT[mime.toLowerCase()] ?? "png";
}

/** Pull every image Blob out of a paste event. Empty array means "not an image paste".
 *  Accepts any clipboardData item whose MIME type starts with `image/` — Windows
 *  WebView2 sometimes reports screenshot pastes with `kind === "string"` rather than
 *  `kind === "file"`, so we don't filter on `kind`. We also fall back to
 *  `clipboardData.files` since some platforms only populate that list. */
export function extractImagesFromClipboard(e: ClipboardEvent): Blob[] {
  const out: Blob[] = [];
  const items = e.clipboardData?.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.type.startsWith("image/")) continue;
      const blob = it.getAsFile();
      if (blob) out.push(blob);
    }
  }
  if (out.length === 0) {
    const files = e.clipboardData?.files;
    if (files) {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.type.startsWith("image/")) out.push(f);
      }
    }
  }
  return out;
}

/** Given existing keys like ["assets/img-1.png", "assets/img-3.jpg"], compute the next filename
 *  (always under "assets/") with the given extension. Numbering is per-tab and avoids collisions
 *  with any existing attachment, regardless of extension. */
export function nextImageFilename(existingKeys: string[], ext: string): string {
  let max = 0;
  for (const k of existingKeys) {
    const m = k.match(/(?:^|\/)img-(\d+)\.[^.]+$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `img-${max + 1}.${ext}`;
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Persist a single pasted-image blob: write bytes to disk (temp folder for unsaved
 *  notes, `<note-dir>/assets/` for saved ones), record the attachment on the tab, and
 *  insert `![pasted-image](assets/img-N.<ext>)` at the editor's current selection. */
export async function handlePastedImage(
  editor: monaco.editor.IStandaloneCodeEditor,
  tabId: string,
  blob: Blob,
): Promise<void> {
  const tab = useAppStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const ext = extFromMime(blob.type);
  const filename = nextImageFilename(Object.keys(tab.attachments ?? {}), ext);
  const relPath = `assets/${filename}`;
  const bytes = await blobToBytes(blob);

  const absPath = tab.filePath
    ? await writeAssetNextToNote(tab.filePath, relPath, bytes)
    : await writeTempImage(tabId, filename, bytes);

  useAppStore.getState().addAttachment(tabId, relPath, absPath);

  const sel = editor.getSelection();
  if (sel) {
    editor.executeEdits("paste-image", [{
      range: sel,
      text: `![pasted-image](${relPath})`,
    }]);
  }
}
