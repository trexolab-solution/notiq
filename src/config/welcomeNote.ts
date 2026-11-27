import { resolveResource } from "@tauri-apps/api/path";

/**
 * The note a first-time user lands on: what Notiq can do, with screenshots, and where to learn more.
 *
 * The screenshots ship with the app (`src-tauri/welcome/`, listed under `bundle.resources`), so they show with no
 * network. A note's images are looked up in its `attachments` map (relative link -> file on disk), which is how
 * `loadWelcomeImages` hands them over. Without them the note simply has no pictures.
 */

export const SITE_URL = "https://trexolab-solution.github.io/notiq/";
export const REPO_URL = "https://github.com/trexolab-solution/notiq";

const IMAGES = ["editor", "login", "ssh"] as const;
type ImageKey = (typeof IMAGES)[number];

const link = (key: ImageKey) => `welcome/${key}.jpg`;

/** The bundled screenshots as `relative link -> absolute path`, or null when they can't be found. */
export async function loadWelcomeImages(): Promise<Record<string, string> | null> {
  try {
    const out: Record<string, string> = {};
    for (const key of IMAGES) {
      // Windows gives extended-length paths (`\\?\C:\…`); the asset protocol wants a plain one.
      out[link(key)] = (await resolveResource(link(key))).replace(/^\\\\\?\\/, "").replace(/\\/g, "/");
    }
    return out;
  } catch {
    return null;
  }
}

/** The welcome note's markdown. Pass the result of `loadWelcomeImages` to include the screenshots. */
export function buildWelcomeNote(images: Record<string, string> | null): string {
  const shot = (key: ImageKey, alt: string) => (images?.[link(key)] ? `\n![${alt}](${link(key)})\n` : "");

  return `# Welcome to Notiq

Notes, secrets and servers, kept on your own computer. Notiq works offline, starts fast and sends nothing anywhere unless you turn a feature on.

[Website](${SITE_URL}) · [Download](${REPO_URL}/releases/latest) · [Report an issue](${REPO_URL}/issues) · [Privacy](${SITE_URL}privacy.html)

---

## What you can do

### Write notes in Markdown

A fast editor with **Source**, **Preview** and **Split** views (switch in the title bar). Tables, task lists, code blocks, Mermaid diagrams, LaTeX and \`[[wiki links]]\` that connect your notes. Notes are plain \`.md\` files on your disk.
${shot("editor", "The editor in Split view: Markdown on the left, the page on the right")}
### Keep passwords and secrets in the Secure Vault

Open the **lock icon** in the sidebar to create your vault. Logins, SSH servers, cards, Wi-Fi, identities, 2-step codes, recovery codes and private notes live in one encrypted file, behind a master password and a recovery key. Add attachments, custom fields and a history to any item.
${shot("login", "A login in the vault: website, username and password, with copy and show buttons")}
### Open your servers from a saved item

Save a server as an **SSH / server** item with a password, a private key, or both. Then open it in the **built-in terminal** or in the **file manager** (SFTP) with one click: browse, edit files, drag and drop, folders and Trash.
${shot("ssh", "An SSH server item with its command and Open in terminal button")}
### And more

- **Browser autofill** — a browser extension fills logins and passkeys; every request is approved in Notiq.
- **Vault Sync** — optional. Use one vault on all your PCs, end-to-end encrypted through your own Google Drive.
- **Share items and backups** — send chosen items to someone as a password-protected file with rules (expiry, number of imports), or keep a backup file.
- **Whiteboard** — an Excalidraw canvas beside your notes (\`Ctrl+3\`).
- **Terminal, sticky notes and command palette** — a shell under your notes, notes that float above other windows, and \`Ctrl+Shift+P\` for every command.
- **AI, only if you want it** — off by default. Run it locally with Ollama, or use Ollama Cloud or OpenRouter with your own key.

## Quick start

| Shortcut | Action |
|---|---|
| \`Ctrl+N\` | New note |
| \`Ctrl+3\` | New whiteboard |
| \`Ctrl+O\` | Open file(s) |
| \`Ctrl+Shift+O\` | Open folder |
| \`Ctrl+S\` | Save |
| \`Ctrl+Shift+P\` | Command palette |
| \`Ctrl+P\` | Export PDF |
| \`Ctrl+,\` | Settings |

Make it yours in **Settings**: 18 themes, fonts, word wrap, default view and more. To see the guided tour again, go to **Settings → General → Welcome tour**.

## Learn more

- The [website](${SITE_URL}) has demos of each feature.
- Found a bug or want something added? [Open an issue](${REPO_URL}/issues).
- New versions are on the [releases page](${REPO_URL}/releases/latest); Notiq also updates itself (**Settings → Updates**).

---

*This is a regular note. Edit it, or close it when you are done. Happy writing!*
`;
}
