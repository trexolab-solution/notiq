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

A small update with fixes and polish.

## 🗂️ File manager

- **Ctrl+F** now goes to the file manager's own **Filter** box instead of the browser's find bar (and **Esc** clears it).

## 🔑 Autofill window

- **Notes are collapsed** in an entry's details until you open them, and the details are laid out like the vault form.
- **You can drag the window** by its header.
- It no longer pops up **empty or white** after a request was cancelled or timed out.

## 🧩 Browser extension 0.8.2

- If your vault was locked while you signed in and you unlocked it afterwards, the offer now correctly says **Update password in Notiq** instead of Save. Reload the extension after updating.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
