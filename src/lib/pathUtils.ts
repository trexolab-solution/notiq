/** Cross-platform filename extraction (handles both / and \ separators). */
export function getFileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

/** Filename without its extension (e.g. "notes/foo.md" → "foo"). */
export function getFileStem(path: string): string {
  const name = getFileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Lowercase file extension without the dot (e.g. "foo.MD" → "md"). Returns "" if none. */
export function getFileExtension(path: string): string {
  const name = getFileName(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Parent directory of a file path (no trailing slash). Forward-slash output. */
export function dirname(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  return slash > 0 ? norm.slice(0, slash) : "";
}

/** Join path segments with forward slashes; collapses repeated separators. */
export function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => {
      const norm = p.replace(/\\/g, "/");
      if (i === 0) return norm.replace(/\/+$/, "");
      return norm.replace(/^\/+|\/+$/g, "");
    })
    .filter(Boolean)
    .join("/");
}

/** True for absolute paths on Windows (C:/...) or POSIX (/...). */
export function isAbsolute(path: string): boolean {
  if (!path) return false;
  if (path.startsWith("/")) return true;
  return /^[A-Za-z]:[/\\]/.test(path);
}

/** Shortens `text` to at most `max` characters by replacing its middle with "…" (keeps a file's extension visible). */
export function middleEllipsis(text: string, max = 40): string {
  if (text.length <= max) return text;
  if (max < 2) return "…".slice(0, max);
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}
