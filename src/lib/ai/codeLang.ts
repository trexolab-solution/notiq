// Maps a fenced code-block language tag (or guesses from content) to a Monaco
// language id + a file extension, for opening AI code snippets as new tabs.

interface LangInfo { lang: string; ext: string; }

// Common fence tags → { Monaco language id, file extension }.
const FENCE_MAP: Record<string, LangInfo> = {
  html: { lang: "html", ext: "html" },
  xml: { lang: "xml", ext: "xml" },
  svg: { lang: "xml", ext: "svg" },
  js: { lang: "javascript", ext: "js" },
  javascript: { lang: "javascript", ext: "js" },
  jsx: { lang: "javascript", ext: "jsx" },
  ts: { lang: "typescript", ext: "ts" },
  typescript: { lang: "typescript", ext: "ts" },
  tsx: { lang: "typescript", ext: "tsx" },
  json: { lang: "json", ext: "json" },
  css: { lang: "css", ext: "css" },
  scss: { lang: "scss", ext: "scss" },
  py: { lang: "python", ext: "py" },
  python: { lang: "python", ext: "py" },
  rb: { lang: "ruby", ext: "rb" },
  ruby: { lang: "ruby", ext: "rb" },
  go: { lang: "go", ext: "go" },
  rs: { lang: "rust", ext: "rs" },
  rust: { lang: "rust", ext: "rs" },
  java: { lang: "java", ext: "java" },
  c: { lang: "c", ext: "c" },
  cpp: { lang: "cpp", ext: "cpp" },
  cs: { lang: "csharp", ext: "cs" },
  php: { lang: "php", ext: "php" },
  sh: { lang: "shell", ext: "sh" },
  bash: { lang: "shell", ext: "sh" },
  shell: { lang: "shell", ext: "sh" },
  ps1: { lang: "powershell", ext: "ps1" },
  powershell: { lang: "powershell", ext: "ps1" },
  sql: { lang: "sql", ext: "sql" },
  yaml: { lang: "yaml", ext: "yaml" },
  yml: { lang: "yaml", ext: "yaml" },
  toml: { lang: "ini", ext: "toml" },
  ini: { lang: "ini", ext: "ini" },
  md: { lang: "markdown", ext: "md" },
  markdown: { lang: "markdown", ext: "md" },
};

/** Resolve a fence tag (lowercased) to a Monaco language + extension. */
function fromFence(tag: string): LangInfo | null {
  return FENCE_MAP[tag.toLowerCase()] ?? null;
}

/** Heuristic guess from the code itself when the fence has no usable tag. */
function fromContent(code: string): LangInfo {
  const c = code.trimStart();
  if (/^<!doctype html|^<html|<\/html>|<body[\s>]/i.test(c)) return { lang: "html", ext: "html" };
  if (/^\s*[{[]/.test(c) && /[}\]]\s*$/.test(code.trim())) {
    try { JSON.parse(code); return { lang: "json", ext: "json" }; } catch { /* not json */ }
  }
  if (/\bdef\s+\w+\s*\(|\bimport\s+\w+|print\(/.test(c)) return { lang: "python", ext: "py" };
  if (/\bfunction\b|=>|console\.|document\.|window\./.test(c)) return { lang: "javascript", ext: "js" };
  if (/^[.#]?[\w-]+\s*\{[^}]*:/.test(c)) return { lang: "css", ext: "css" };
  return { lang: "plaintext", ext: "txt" };
}

/** Decide the language + extension for a code block: prefer its fence tag. */
export function resolveCodeLang(fenceTag: string, code: string): LangInfo {
  return (fenceTag && fromFence(fenceTag)) || fromContent(code);
}
