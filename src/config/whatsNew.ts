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

- **Vault Sync with Google Drive** — use the same vault on all your PCs. Open **Settings → Vault → Sync**, connect your Google account and turn on *Sync this vault*. On another PC, choose **Use my vault from Google Drive** on the vault setup screen and enter your master password. Everything is encrypted on your PC before it's uploaded, and Notiq can only see its own files in your Drive.
- **No lost edits** — if the same note was changed on two PCs, the newer version is kept and the other one is saved in the note's history. You get one notification saying which notes and devices.
- **Already have a vault on the other PC?** — Notiq backs it up first, then imports its entries into the synced vault (identical logins are skipped, different ones are kept as *"Name (This PC)"*), or just keeps the backup file. Your choice.
- **Sync at a glance** — a small indicator in the status bar shows when the vault is synced, syncing, offline or needs attention. Click it for the details, the list of devices and *Sync now*.
- **Always in the loop** — you see your vault uploading the first time, get one notice when another PC joins your vault, and a single *Reconnect* prompt if Google asks you to sign in again.
- **Attachments sync too** — within the usual limits: up to 5 MB per file, 25 MB per vault and 20 files per note.
- **Your account, your control** — disconnect any time; your data stays in your Drive until you delete it (Google Drive → Settings → Manage apps). Sync is off until you turn it on.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
