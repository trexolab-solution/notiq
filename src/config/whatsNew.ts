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

Vault items are easier to read and edit, and .nqb files now open in the right place.

## 🧩 Vault items, section by section

- **One section at a time:** SSH servers, logins, cards, Wi-Fi, identities and recovery codes open as sections (Connection, Sign in, Details, Attachments…) in a list beside the form, or as tabs when the tab is narrow.
- **SSH sign-in:** choose Password, SSH key or Both, pick what to use when both are saved, and see at a glance whether the server is ready to connect.
- **Cleaner fields:** copy, show, open and generate buttons sit inside the field, Attachments start open, and **Unsaved changes** shows next to Save.

## 📦 Share files and backups

- Double-clicking a .nqb file opens **Import** for a share file and **Restore** for a backup. Before, a share file was refused.
- The Unlock window now shows above Import and Restore instead of hiding behind them.

## 🖼️ Images

- Locking a note into the vault now takes its images with it, encrypted with the note, instead of leaving broken links.

## 👋 Welcome

- The first-run welcome note now shows what Notiq can do, with screenshots and links. Replay the tour in Settings → General.

## 🔑 Passkeys are on by default

- The browser extension now offers to save and use passkeys with Notiq unless you turn it off in its popup. It still asks you every time.

## 🔧 Other

- The storage folder is chosen in Settings → Vault only; the sidebar no longer has a shortcut for it.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
