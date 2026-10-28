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

## ✨ Highlights

- **One encrypted vault file** — every locked note, login, SSH entry and API key now lives in a single encrypted database (**vault.nqdb**) unlocked by one master password. Titles, folders and tags are hidden too. Everything stays on this device: **cloud sync and backup have been removed**, so copy \`vault.nqdb\` and \`vault.json\` yourself if you want a backup. Notes from older versions are moved over automatically the first time you unlock, and Notiq asks before deleting the old files.
- **A real file manager for secrets** — the 🔒 panel now has folders, drag-and-drop, rename, duplicate, tags with filtering, starred items, search and a **Recycle Bin** (restore, delete forever, auto-purge after 30 days).
- **Smarter entries** — a new **SSH / server** editor (key or password sign-in, key analysis, a copyable \`ssh\` command, key file import), a **password generator** with options you can remember, and icon-only copy buttons that confirm and clear the clipboard after 20 seconds.
- **Safer default location** — the vault now lives in Notiq's app-data folder by default, and you get a warning before choosing a folder synced by OneDrive, Dropbox, Google Drive or iCloud.
- **Browser autofill, improved** — the Chrome / Edge / Brave extension (v0.2.0, in the repo's \`browser-extension\` folder) shows a Notiq icon on login fields and can offer to **save new logins** from the browser. Every fill and every save needs your approval in Notiq, and focus now returns to your browser afterwards.
- **Fixes** — the Source / Preview / Split switch is back for locked notes, and the New-in-vault menu no longer gets cut off.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
