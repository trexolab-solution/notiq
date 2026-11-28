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

A fix release for the autofill window, with a clearer update notice.

## 🌐 Browser autofill

- The autofill window now also closes after requests it answers **without showing itself** (opening the extension popup, checking whether to offer Save, a trusted site).
- Until Notiq needs to show it, the window is kept **off screen**. This is aimed at the empty white box some screenshots showed.

## 🔔 Updates

- A card now tells you when a new version is available. **Later** hides it for a few hours.

## 🚀 Start with your computer

- After each update Notiq makes sure it **launches at sign-in**, and repairs a startup entry that pointed somewhere else. This update turns it on even if you had turned it off before. To keep it off, switch it off in **Settings → General** (turning it off only in Windows doesn't last past an update).

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
