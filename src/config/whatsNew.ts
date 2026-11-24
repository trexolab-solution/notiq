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

Share chosen items from your vault with someone, with rules that you set, and a better file viewer for SFTP.

## 🔗 Share items

- **Share chosen items:** open **Export** in Settings → Vault → Backup (or right-click a note or folder and choose **Share…**). Pick the notes or folders, give the receiver a password, and save a .nqb file. It never holds your master password, your history, or anything you didn't pick.
- **Rules in the file:** how many times it can be imported, when the file expires (after a set time, or on a date and time), when the items are removed from the receiver's vault, and whether the file is deleted after its last import. The rules are sealed inside the file, so nobody can edit them.
- **Items remove themselves:** at the time you set, on every device that syncs the vault. Old copies of them on that PC are cleaned too.
- **Import:** open **Import** and choose **Import shared items**, or drop the file on the dialog. Before anything is added, Notiq shows what is in it and when it will be removed.

## 📄 SFTP file viewer

- **Markdown** opens as a page (with Edit and Preview), **CSV and TSV** as a table you can sort, and **PDF** files in the built-in viewer.

## 🔐 Vault sync

- **Disconnect and remove the vault from this PC:** a new choice in the Disconnect dialog. Your latest changes are uploaded first; the vault stays in Google Drive.

## 🔧 Fixes

- A blank window that could appear over the app is now repainted or rebuilt by itself, and window events are logged to window.log in the app data folder.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
