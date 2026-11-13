import { APP_VERSION } from "./app";

/**
 * "What's New" release note, shown once in the editor after the app updates to a
 * new version (see `lib/firstRun.ts` + the startup effect in `App.tsx`). It opens
 * as an in-memory Markdown *preview* tab, so keep two rendering constraints in mind:
 *   • Lead with a `#` heading — an unsaved note derives its tab title from the
 *     first line, so this keeps the title as "What's New in Notiq …".
 *   • Use absolute `https://` / `data:` image URLs only; relative paths can't
 *     resolve without a file on disk.
 *
 * Update this string for every release — keep it short and highlight-focused.
 */
export const WHATS_NEW = `# What's New in Notiq ${APP_VERSION}

Thanks for updating! Here's what's new in this release.

## 🗂️ A file manager for your servers

- **Open it from the vault** — use *Open file manager* on a saved SSH entry (or the folder icon on its row). It signs in like the terminal does, with nothing to install, and opens in a tab or in its own window (**Settings → Vault → File manager**).
- **Open and edit files in place** — pictures are shown, text opens in the editor and saves straight back to the server. If the file changed on the server meanwhile, Notiq asks before overwriting.
- **Folders and files, both ways** — upload and download whole folders, drag files in from your desktop, or paste files you copied in Explorer. A card in the corner shows progress, with cancel.
- **Move things around** — cut and paste, or drag items onto a folder or a part of the path bar. When a name is taken you choose *Replace*, *Keep both* or *Skip*.
- **Deleted items go to the Trash** — the server's own Trash, so you can restore them (or delete them for good with *Shift+Delete*).
- **More** — right-click menus, list or grid layout with three sizes, permissions, new file and new folder, back and forward.
- **It reconnects by itself** if the connection drops, and returns to the same folder.

## 🔒 A bit tighter

- The browser extension can list logins less often, and its connection file is private to your user.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
