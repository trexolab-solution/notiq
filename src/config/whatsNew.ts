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

## 🗂 Vault sidebar

- **Preview tabs** — clicking a vault item opens it in a preview tab (italic title) that the next click reuses, so tabs don't pile up. Editing it, double-clicking, **Ctrl+click** or the row's "Open in new tab" button keeps it in a tab of its own.
- **Create where you mean** — click empty space in the sidebar (or press Esc) to clear the selection, then New item or New folder creates at the vault root. The target folder is outlined.
- **Tidier toolbar** — New item, New folder, Collapse all / Expand all and Lock up front; Vault health, Import logins from CSV, sort and grouping are under **⋯ More actions**.

## 🔑 SSH keys, redesigned

- **Import several files at once** — drop or pick key files; the private and public key each go to their own field, where you can see and edit them.
- **Key details** — type, size, SHA256 fingerprint and comment, whether the private key has a passphrase, and whether the two keys match.
- **Other files** — extra files are kept in a list with View, Copy and Remove (with Undo).

## 🌐 Browser autofill

- **No repeat prompts** — Notiq no longer offers to save a login that's already saved, and offers **Update password** when you sign in with a new password (also on change-password forms).
- **Private windows** — a new setting under Settings → Vault → Browser autofill decides whether autofill works in private (incognito) windows. It's off by default.
- **Password generator** in the extension's toolbar popup, with Fill password for the page you're on.

## ⚡ Quick search

- **Fixed:** the quick search window (Ctrl+Alt+K) could reappear on its own as a blank window after the vault locked. It now only opens when you ask, and always closes when you click elsewhere.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
