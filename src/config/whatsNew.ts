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

## 🛡 Vault Sync, safer

- **Fixed: data lost after reconnecting** — if you disconnected Google Drive, deleted items on this PC and reconnected, sync could delete them from Drive too. Disconnecting now detaches this PC: when you reconnect (or connect an account that holds your vault), Notiq restores from Drive first and merges, so items deleted while disconnected come back. Changes you made while disconnected are kept.
- **Asks before deleting a lot** — if a sync would delete many items from Drive (or every item), Notiq stops and asks: **Restore from Drive** or **Apply deletions everywhere**. It also asks on the first sync after you resume a paused sync.
- **Backups first** — before any large deletion or a reconnect, Notiq saves an encrypted copy of both this PC's vault and the Drive copy.
- **Restore from a date** — Notiq keeps a daily copy of your vault in Drive for 30 days. Go back to any of them from **Settings → Vault → Sync → Restore from a date…**. Nothing on this PC is removed.

## 🔵 See what came from Drive

- **Dots on synced items** — items added, changed or restored by sync show a small dot in the vault sidebar, with a **Recently synced** list and **Mark all as seen**.
- **Show changes** — an entry changed by sync shows "Updated from Drive"; **Show changes** compares the version before the sync with the current one, field by field, with secrets hidden until you reveal them.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
