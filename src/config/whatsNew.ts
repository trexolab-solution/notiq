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

Easier to read, easier to use with the keyboard, and fewer surprises.

## ♿ Readability and keyboard use

- **Clearer secondary text:** muted text now has enough contrast in every theme.
- **Keyboard focus is visible** in more places: search boxes, the vault list, menus and the autofill window.
- **Screen-reader labels** on the terminal, sticky-note and whiteboard buttons, and chat history, context files and file pickers now work with Tab, Enter and Space.
- **Bigger click targets** for tab close buttons and small icon buttons.

## 🖥️ App

- **No more blank pop-up window** after locking and unlocking the vault: a stray empty autofill window now hides itself, and shows a message instead of a blank screen if it ever fails.
- **A heads-up when Notiq goes to the tray:** the first time you close the window, a short note tells you it is still running (right-click the tray icon to quit).
- **Errors are no longer silent:** failed refreshes after an import, restore or sync, the SFTP trash check and terminal copy/paste now tell you.
- **Smaller window limit:** the window can't be shrunk below a usable size, and the terminal loads only when you open it.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
