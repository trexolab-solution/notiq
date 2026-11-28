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

A security fix for browser autofill.

## 🛡️ Look-alike site warning

- When a page **looks like a site you have a login for** but isn't it, Notiq now shows its warning. Before this update the warning did not stay on screen. Nothing was filled on such a page then either.
- Close the warning (**OK**, **×** or **Esc**) and the browser is told there is no login for this page.

## 💡 What to do when you see it

- Check the page's address carefully before you type a password there.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
