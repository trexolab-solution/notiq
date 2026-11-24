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

Share a folder with your phone over **WebDAV**, now with its own file manager, HTTPS and a better SFTP file manager.

## 🌐 WebDAV

- **Renamed and rebuilt:** "Phone Share" is now **WebDAV**, with its own Settings section, status-bar button and QR code.
- **A real file manager in the browser:** Notiq-branded page with a folder tree, command bar, type-aware clicks, drag-select, clipboard, Properties and drag to move several items at once.
- **Google Drive-style uploads:** drag files in, see progress, cancel or retry.
- **HTTPS (optional):** encrypt the connection with a self-signed certificate. The fingerprint is shown to compare on your phone.
- **Your own dialogs:** new file, rename and delete use the page's dialogs instead of the browser's.

## 📁 SFTP file manager

- **Zip and unzip** on the server, **Properties** with folder sizes, and **drag-select** with a band.
- A cleaner right-click menu: grouped, no duplicates. Dragging several items moves them all.

## 🔐 Vault and browser extension

- Saving a login while the vault is locked now offers **Unlock & save**.
- Long names in the Vault sidebar no longer clip, and rename errors show inline.

## ⚙️ Settings

- Settings are grouped (Workspace, Tools, Security, App), with new **File Manager** and **WebDAV** sections.

## 🔧 Fixes

- The remote file manager no longer reconnects (and no longer cuts an upload) when you switch tabs.
- Opening Settings puts the cursor in the search box.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
