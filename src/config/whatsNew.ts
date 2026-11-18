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

Vault selection, tags and a few time savers.

## 🔐 Vault

- **Select a whole folder or website:** ticking a folder ticks everything inside it, and a website row has its own tick box for all of its logins.
- **Manage tags:** rename a tag, merge it into another, or delete it from every entry (the ⚙ button in the tag strip, or the vault's ⋯ menu).
- **Hide for 5, 10 or 30 minutes:** in *Settings → Vault*, hide Notiq from screenshots and screen sharing for a set time, then your saved choice applies again by itself.
- **Server sign-in remembers your choice:** when a saved server has both a key and a password, the one you used last is selected and marked *Last used*.
- The **Caps Lock** indicator is now an icon inside the password field, so dialogs no longer jump.

## 🖥️ App

- **Ctrl+B** shows or hides the side panel (inside the code editor, where Ctrl+B is Bold, use **Ctrl+Shift+B**).
- Hover hints are now the app's own only: no more double tooltips.
- Clearer section headings in Settings.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
