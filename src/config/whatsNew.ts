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

## 🔐 Vault forms, easier to use

- **Save button** — structured entries (logins, cards, SSH, recovery codes…) have a Save button next to History, and Notiq asks before closing a tab or quitting with unsaved changes.
- **The Name is the item name** — saving renames the item in the sidebar to match, and renaming in the sidebar updates the Name.
- **History beside the form** — History opens as a resizable panel on the right instead of a pop-up.
- **Header stays in view** — the title, Save and History stay at the top while you scroll a long entry.
- **Custom fields, redesigned** — clearer label and value, copy and reveal on every field, drag a field by its handle to reorder (or use the keyboard), and the ⋯ menu to hide a value or remove it.
- **Websites, recovery codes and passkeys** — tidier list controls with Undo after removing.
- **Generate asks first** — generating a password on a login that already has one asks before replacing it.

## 📎 Attachments

- **Drag and drop** — drop files from your computer onto an entry to attach them.
- **Preview** — open images and text files inside Notiq without saving them to disk; Undo after removing a file.

## 💾 Backup and restore

- **Merge a backup** — restoring a backup can now **merge** it into your current vault instead of replacing it. Nothing is removed and your master password stays the same.
- **Step by step** — restore is now a short guided flow (file, method, confirm), and you can drop the backup file onto it.
- **Sync fix** — a restored backup is no longer emptied by the first Vault Sync afterwards.

## ⚡ Faster 2-step codes

- **Quick search** (Ctrl+Alt+K) shows live 2-step codes for your logins; press **Shift+Enter** to copy one without opening the main window.
- **Autofill window** — a details button on each login shows its fields with copy buttons, and can open it in Notiq.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
