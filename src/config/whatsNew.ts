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

## 🖥️ SSH, built right in

- **Sign in from the terminal** — click the **Server** button in the terminal (or *Open in terminal* on a saved SSH entry or in the vault sidebar) to connect with the key or password from your vault. If an entry has both, Notiq asks which to use.
- **Nothing to install** — Notiq has its own SSH client, so it works on a fresh PC with no OpenSSH. New servers are confirmed in the terminal and remembered, and a changed host key is refused.
- **Generate SSH keys** — create an Ed25519 or RSA key pair right in the SSH form, with an optional passphrase.
- **Password and key together** — one SSH entry can now keep both.

## 🗂️ Cleaner forms

- Logins, SSH, cards, Wi-Fi and identities are laid out in clear sections; the 2-step setup key is hidden until you show it, with a bigger live code.
- A new credential opens straight in its form with the name ready to type, and moving an entry to Trash asks first.

## 💾 Shorter backups

- Backups are now saved as **.nqb**. Double-click one to open the restore dialog. Older **.nqbackup** files still work.

## 🧩 Browser extension 0.8.1

- When your vault is locked, the popup now has **Unlock**: Notiq opens a small window for your master password. Reload the extension after updating.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
