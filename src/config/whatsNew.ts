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

## ✨ Vault Sync with Google Drive (new in 0.9.0)

- **Your vault on all your PCs** — click the **cloud button** in the title bar (or choose **Use my vault from Google Drive** on the vault setup screen) and sign in with Google. Everything is encrypted on your PC before it's uploaded, and Notiq can only see its own files in your Drive.
- **No lost edits** — if the same item was changed on two PCs, the newer version is kept and the other one is saved in its history. You get one notification saying which items and devices.
- **Two different vaults?** — Notiq backs up this PC's vault first, then lets you add its items to the Google Drive vault or switch to the Drive vault. *Keep this PC separate* leaves sync off.
- **Changed your master password?** — the new password works on every PC. If two PCs change it at about the same time, the later change wins.
- **Pause any time** — *Pause* stops syncing on this PC; *Resume sync* starts again. If your vault is no longer in Google Drive, Notiq asks before uploading it again.
- **Attachments sync too** — up to 5 MB per file, 25 MB per vault and 20 files per item.
- **Your account, your control** — disconnect any time; your data stays in your Drive until you delete it (Google Drive → Settings → Manage apps). Sync is off until you turn it on.

## 🔑 Notiq Autofill 0.6.0 (new in 0.9.0)

- **A better toolbar popup** — see the logins for the current site, click one to fill it, or copy its username, password or 2FA code.
- **Right-click menu** — right-click a field and choose **Notiq** to fill a login, a 2FA code or an identity, or to generate a password.
- **Identities** — a new vault item for your name, email, phone and address (Home, Office…). Notiq fills it into address and checkout forms.
- **Custom fields** — a login's custom fields, like a bank's *Customer ID*, are filled when the page has a field with the same name.
- **Choose what to update** — when several logins share a username, the save prompt lets you pick which one to update, or save a new one.
- **Smarter filling** — 2FA codes on their own page, logins inside web components, and generated passwords that follow the site's rules.

## 🛠️ Also new

- **Clear copied secrets after** — choose 15 s, 30 s (default), 1 min, 2 min or Never in **Settings → Vault**.
- **Resizable vault sidebar** — drag its edge, or use the arrow keys; Notiq remembers the width.
- **Clearer loading and hovers** — consistent loading indicators and VS Code-style tooltips throughout the app.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
