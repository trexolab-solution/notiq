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

## ↩️ Autofill back to the previous design

- **The 0.9.6 autofill redesign is undone.** The approval window, the login menu in web pages and the strong password card are back to how they were in 0.9.5. Reload the browser extension after updating.

## 🛡 Still included from 0.9.5

- **Safer Vault Sync** — reconnecting Google Drive restores from Drive first, Notiq asks before deleting many items, keeps backups, and offers **Restore from a date** in Settings → Vault → Sync.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
