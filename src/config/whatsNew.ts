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

## ✨ Highlights

- **Secure Vault** — lock any note with a master password. Locked notes are saved as encrypted **.nqv** files (Argon2id + XChaCha20-Poly1305) and are never sent to AI, search or the graph. Right-click a tab → **Lock with Vault**.
- **Organised storage** — a new 🔒 panel in the left bar shows your vault folder. Pick where it lives and file notes into folders like *SSH* or *Logins*.
- **Safer by design** — auto-lock on idle or when the window closes, a customizable panic-lock shortcut (default **Ctrl+Alt+L**), and a recovery key.
- **Sync across your devices (optional)** — Google Drive or Telegram, two-way and automatic. Only encrypted files leave the app. On a new computer choose **Restore** on the vault setup screen. Set it up in **Settings → Vault**.
- **Logins & browser autofill** — save structured logins (password generator, 2-step codes, auto-clearing copy) and fill them into Chrome, Edge or Brave with the Notiq Autofill extension. Every fill needs your approval in Notiq. Extension is in the repo (browser-extension folder).
- **Smarter title bar** — buttons collapse into **⋯** menus on narrow windows, and the editor-mode switcher shrinks to icons.
- **Terminal feels native** — proper multi-line paste (great for TUIs like Claude Code), Ctrl+C to copy a selection, right-click copy/paste, and no more garbled characters.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
