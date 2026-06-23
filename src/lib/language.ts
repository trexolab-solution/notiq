import { getFileExtension } from "./pathUtils";

/** Maps file extensions → Monaco editor language IDs */
const EXT_LANG: Record<string, string> = {
  // Web
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript",
  html: "html", htm: "html", xhtml: "html",
  css: "css",
  scss: "scss", sass: "scss",
  less: "less",
  json: "json", jsonc: "jsonc",
  // Systems / compiled
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp",
  cs: "csharp",
  java: "java",
  go: "go",
  rs: "rust",
  // Scripting
  py: "python", pyw: "python",
  rb: "ruby",
  php: "php",
  lua: "lua",
  r: "r",
  // Shell
  sh: "shell", bash: "shell", zsh: "shell",
  ps1: "powershell",
  bat: "bat", cmd: "bat",
  // Data / config
  xml: "xml", svg: "xml", xsl: "xml",
  yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  sql: "sql",
  graphql: "graphql", gql: "graphql",
  // Mobile / other
  swift: "swift",
  kt: "kotlin", kts: "kotlin",
  dart: "dart",
  scala: "scala",
  // Docs
  md: "markdown", markdown: "markdown",
  txt: "plaintext",
};

/** Returns a Monaco language ID for the given file path (or "markdown" for in-memory). */
export function getLanguageFromPath(filePath?: string): string {
  if (!filePath) return "markdown"; // untitled in-memory note
  const ext = getFileExtension(filePath);
  if (!ext) return "plaintext";
  return EXT_LANG[ext] ?? "plaintext";
}

/**
 * Returns true for files where the Markdown toolbar + preview should be shown:
 * untitled in-memory notes, and files with .md / .markdown / .txt extensions.
 */
export function isMarkdownLike(filePath?: string): boolean {
  if (!filePath) return true;
  const ext = getFileExtension(filePath);
  return ext === "md" || ext === "markdown" || ext === "txt" || ext === "";
}
