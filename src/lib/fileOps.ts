import { readTextFile, writeTextFile, writeFile as writeFileBytes, readDir } from "@tauri-apps/plugin-fs";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getFileStem } from "./pathUtils";

export type FileEntry = { path: string; content: string; title: string };

const TEXT_EXTS = /\.(md|markdown|txt|js|jsx|ts|tsx|html|htm|css|scss|less|json|xml|yaml|yml|toml|ini|sh|bash|zsh|py|rb|php|go|rs|java|c|h|cpp|cs|swift|kt|lua|sql|r|dart)$/i;

// Directories that are never useful to open as notes
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "dist", "build", "out", ".output",
  ".next", ".nuxt", ".vite", ".turbo",
  "coverage", "__pycache__", ".pytest_cache",
  ".vscode", ".idea", ".fleet",
  "vendor", "target", ".cargo",
  ".DS_Store", "Thumbs.db",
]);

/** Show an OS open-file dialog with multi-select enabled. */
export async function pickAndReadMultipleFiles(): Promise<FileEntry[]> {
  const selected = await open({
    multiple: true,
    filters: [
      { name: "Text / Markdown", extensions: ["md", "markdown", "txt"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (!selected) return [];
  const paths = Array.isArray(selected) ? selected : [selected];
  const results: FileEntry[] = [];
  for (const p of paths) {
    try {
      const content = await readTextFile(p);
      const title   = getFileStem(p);
      results.push({ path: p.replace(/\\/g, "/"), content, title });
    } catch (e) {
      console.warn(`fileOps: failed to read file "${p}":`, e);
    }
  }
  return results;
}

/**
 * Recursively collect all text files under `dirPath`.
 * Skips common non-user directories (node_modules, .git, dist, …).
 */
async function collectFiles(
  dirPath: string,
  results: FileEntry[],
  maxDepth = 6,
  depth = 0,
): Promise<void> {
  if (depth > maxDepth) return;
  let entries: Awaited<ReturnType<typeof readDir>>;
  try { entries = await readDir(dirPath); } catch { return; }

  for (const entry of entries) {
    if (!entry.name) continue;
    if (IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = `${dirPath}/${entry.name}`;
    if (entry.isDirectory) {
      await collectFiles(fullPath, results, maxDepth, depth + 1);
    } else {
      if (!TEXT_EXTS.test(entry.name)) continue;
      try {
        const content = await readTextFile(fullPath);
        const title   = getFileStem(entry.name);
        results.push({ path: fullPath, content, title });
      } catch (e) {
        console.warn(`fileOps: skipped unreadable file "${fullPath}":`, e);
      }
    }
  }
}

/** Show an OS folder-picker and return all text files inside it (including subfolders). */
export async function pickFolderAndReadFiles(): Promise<{ files: FileEntry[]; folderPath: string } | null> {
  const picked = await open({ directory: true, multiple: false });
  if (!picked || Array.isArray(picked)) return null;
  const folderPath = (picked as string).replace(/\\/g, "/");

  const files: FileEntry[] = [];
  await collectFiles(folderPath, files);
  return { files, folderPath };
}

/** Show an OS save-file dialog and return the chosen path, or null if cancelled. */
export async function pickSavePath(suggestedName: string): Promise<string | null> {
  const defaultPath = suggestedName.match(/\.[^.]+$/) ? suggestedName : `${suggestedName}.md`;
  const result = await save({
    filters: [
      { name: "Markdown",  extensions: ["md"] },
      { name: "Text",      extensions: ["txt"] },
      { name: "All Files", extensions: ["*"] },
    ],
    defaultPath,
  });
  return result ?? null;
}

/** Write text to a file path. */
export async function writeFile(path: string, content: string): Promise<void> {
  await writeTextFile(path, content);
}

/** Write raw bytes to a file path (used for image attachments). */
export async function writeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
  await writeFileBytes(path, bytes);
}
