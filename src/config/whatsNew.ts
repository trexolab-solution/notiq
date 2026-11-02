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

## ⚡ Quick search (Ctrl+Alt+K)

- **No more stuck blank window** — the quick search window now shows only once it is ready, and closes when you click anywhere outside it.
- **More reliable** — pressing Ctrl+Alt+K again always closes it, and it recovers on its own if it ever stops responding.

## 🔑 Autofill, redesigned

- **Clearer chooser** — the browser autofill window shows the site, what will be filled, and each login with its username and badges for 2-step codes, passkeys and last use.
- **Find the right login fast** — search when a site has many logins, pick with ↑/↓ and Enter, or double-click to fill.
- **Safer by default** — the window opens with focus on Deny, so a stray Enter never fills anything.
- **Details view** — view a login's fields with copy buttons and a live 2-step code with a countdown ring, then fill it or open it in Notiq.

## 🛠 Under the hood

- Updated dependencies, including Tauri 2.12.5, with security fixes for the app and its libraries.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
