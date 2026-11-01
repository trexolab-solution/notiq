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

## 🛡️ Stronger vault security

- **Hidden from screenshots and screen sharing** — while the vault is unlocked, Notiq's windows show up black in screenshots, recordings and screen shares. Change it in **Settings → Vault → Locking** (While unlocked, Always, Off).
- **Create a new recovery key** — in **Settings → Vault**, after confirming your master password. The old key stops working for this vault (older backup files still open with it).
- **Master password strength** — a strength meter when you choose a new master password; very weak and common passwords are refused.
- **Breached password check** — **Vault Health** can check your logins against known data breaches (Have I Been Pwned). Off by default; only the first 5 characters of each password's hash are sent.
- **Failed unlock attempts** — after you unlock, Notiq tells you if someone typed a wrong password since your last unlock.
- **Stronger encryption settings, automatically** — older vaults are upgraded to today's settings the next time you unlock with your password.

## 🗂️ Easier to find logins

- **Search by website** — the vault search now also matches sites and usernames.
- **Grouped by site** — several logins for the same website are grouped under one row, with the usernames shown. Turn it off from the sidebar's right-click menu.

## 🔑 Notiq Autofill 0.7.0

- **Phishing warning** — if you type a saved password on a site it doesn't belong to, Notiq warns you. The password never leaves the extension.
- **Hide Notiq on a site** — from the key icon's right-click menu or the toolbar popup.
- **Toolbar fill inside web components** — the toolbar button and Alt+Shift+L now reach login fields inside web components.
- **Passkeys (experimental)** — turn on *Save and use passkeys with Notiq* in the toolbar popup to keep passkeys in your vault. Notiq asks before saving or using one.
- **Firefox** — install steps for Firefox are in **Settings → Vault → Browser autofill**.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
