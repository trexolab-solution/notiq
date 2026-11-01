/** What kind of file an attachment is: picks its icon and whether it can be previewed in the app. */
export type AttachmentKind =
  | "image" | "text" | "code" | "key" | "pdf" | "archive" | "audio" | "video" | "sheet" | "doc" | "other";

const EXT_KIND: Record<string, AttachmentKind> = {};
const add = (kind: AttachmentKind, exts: string) => { for (const e of exts.split(" ")) EXT_KIND[e] = kind; };
add("image", "png jpg jpeg gif webp bmp ico svg avif");
add("text", "txt md markdown log csv tsv rtf");
add("code", "json xml yaml yml toml ini conf cfg env sh bash ps1 bat cmd py js ts html htm css sql");
add("key", "pem key pub crt cer der p12 pfx asc gpg kdbx ppk jks keystore ovpn");
add("pdf", "pdf");
add("archive", "zip gz tgz 7z tar rar bz2 xz");
add("audio", "mp3 wav ogg flac m4a aac");
add("video", "mp4 webm mov mkv avi");
add("sheet", "xls xlsx ods numbers");
add("doc", "doc docx odt pages ppt pptx odp");

export const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

export function attachmentKind(name: string, mime = ""): AttachmentKind {
  const byExt = EXT_KIND[extOf(name)];
  if (byExt) return byExt;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/")) return "text";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "other";
}

/** Text-like key files that are safe to show as text (binary ones like .p12 / .kdbx are not). */
const TEXT_KEYS = new Set(["pem", "key", "pub", "crt", "cer", "asc", "ppk", "ovpn"]);
/** Image types the webview can draw. */
const IMAGE_PREVIEW = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"]);

/**
 * How "Open" shows the file inside the app (decrypted in memory only, never written to disk),
 * or null when it can't: those files can still be saved out with "Save as".
 */
export function previewMode(name: string, mime = ""): "image" | "text" | null {
  const ext = extOf(name);
  const kind = attachmentKind(name, mime);
  if (kind === "image") return IMAGE_PREVIEW.has(ext) || mime.startsWith("image/") ? "image" : null;
  if (kind === "text" && ext !== "rtf") return "text";
  if (kind === "code") return "text";
  if (kind === "key") return TEXT_KEYS.has(ext) ? "text" : null;
  return null;
}
