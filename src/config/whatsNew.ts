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

## 🧩 A new browser extension popup

- **Made for tapping** — the extension popup now has three tabs at the bottom: **Logins**, **Generator** and **Settings**.
- **Logins** — a card for the current site, a search box, and a row for each saved login with its 2-step badge. Tap a row to fill; copy the username, password or 2-step code from the row's icons.
- **Generator** — a large password with its strength, **Regenerate**, **Copy** and **Fill password**, plus length and character options.
- **Settings** — the same options with larger rows and switches; the site lists slide in with a back button.
- Larger text and better contrast in light and dark. Reload the extension after updating (it is version 0.8.0).

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
