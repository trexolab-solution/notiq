# Secure Vault

Keep passwords, SSH keys, API keys and private notes behind **one master password**. Everything in the vault lives in **one encrypted file on your computer**. Nothing leaves your PC unless you turn on [Vault Sync with Google Drive](#vault-sync-with-google-drive), and then only encrypted. There is no Notiq account or server.

## One encrypted file

All locked entries (notes, logins, SSH entries, API keys, cards, Wi-Fi, recovery codes) are stored in a single database file, `vault.nqdb`. Names, folders, tags and contents are all inside it, so nothing about your secrets is readable on disk. Saves are atomic (a crash can't leave a half-written file) and the previous version is kept as `vault.nqdb.bak.1–3` so a bad write can always be rolled back.

- **Where it lives:** by default in Notiq's app-data folder (`%APPDATA%\com.trexolab.notiq\` on Windows), next to the small `vault.json` key file. You can pick another folder in **Settings → Vault**; Notiq warns you if the folder is synced by OneDrive, Dropbox, Google Drive, iCloud Drive, etc., because that would copy your encrypted vault to someone else's servers. Vaults created by older versions in `Documents/Notiq Vault` keep working where they are, and their old per-note `.nqv` files are imported into the database (originals are only deleted if you confirm).
- **Backups (Settings → Vault → Backup):** Notiq does not upload anything unless you turn on sync, so you make the backups. **Export encrypted backup** (asks for your master password again) writes one `.nqb` file you can put on a USB drive (double-click it to open the restore dialog; `.nqbackup` files from earlier versions still work); **Restore from backup file** is on the vault setup screen and in Settings, and replacing an existing vault first keeps the old files in a `before-restore-…` folder. A gentle reminder appears when you have never backed up or the last backup is over 30 days old. The backup is still protected by your master password and recovery key, and cannot be opened without them.
- **Format upgrades:** the database is versioned (v2 adds entry history and attachments). The first save after upgrading an older database keeps a copy as `vault.nqdb.v1.bak`.

## Sidebar: a file manager for your secrets

- **Resizable** — drag the sidebar's edge (or use the arrow keys); Notiq remembers the width
- **Folders** with expand/collapse, new folder, rename, drag-and-drop move and "Move to…"
- **Tags and search** — filter by one or more tags (AND), search names and tags; contents are never searched
- **Starred** items pinned at the top, **duplicate**, sort by name or last modified
- **Recycle Bin** — deleting moves items to the trash; restore them, delete forever, or empty the bin (items are removed for good after 30 days)
- Right-click menus and keyboard control (Enter to open, `F2` rename, `Delete` to trash, arrow keys)
- **Vault health** (shield icon) — a check for weak, reused, very old and empty passwords and http-only sites, done on your computer; passwords are never shown in the report. An optional breached-password check (off by default) can also flag passwords found in known data breaches: only the first 5 characters of each password's SHA-1 hash are sent to [Have I Been Pwned](https://haveibeenpwned.com/Passwords), so the password and full hash never leave your computer
- **Import logins** — from Chrome / Edge / Brave, Bitwarden or KeePass CSV files (or any CSV with a column mapping), with a preview, duplicate handling and folder mapping

## Entry types

- **Secure note** — free text / Markdown
- **Login** — site, username, password, optional 2-step (TOTP) secret with a live code
- **SSH / server** — host, port, username and a password, a private key, or both (Notiq asks which to use when you open it in the terminal). Pasted keys are analysed as you paste (OpenSSH, PEM, PuTTY; encrypted or not; a public key is flagged), you can import a key file or generate a new Ed25519 / RSA pair, and a ready `ssh -p … user@host` command can be copied. Jump host, host-key fingerprint and notes sit under *Advanced*
- **API key / secret** — service, token, optional environment variable name
- **Card** — cardholder, number (grouped as you type, brand shown, Luhn hint), expiry, CVV, PIN
- **Wi-Fi** — network name, password, security type; copy the `WIFI:` text used for QR codes
- **Recovery codes** — a list of one-time codes with per-code "used" marks and *Copy next unused*
- **Identity** — full name, email, phone, address lines 1–2, city, state, PIN/ZIP and country (e.g. "Home", "Office"); the browser extension can fill it into address and checkout forms
- **Custom fields, other sites and attachments** — every structured entry can carry custom fields (optionally secret), a login can list extra websites, and files (up to 5 MB each, 25 MB per vault) can be attached inside the same encrypted file
- **History** — the last 10 versions of every entry are kept inside the vault; preview and restore them from the History button (a restored version becomes the current one)
- **Password generator** — a small popup next to *Generate* lets you choose the length and character classes (and avoid look-alike characters); tick *Remember my choice* to skip the popup next time. Change it later from the ⚙ button or **Settings → Vault → Password generator**
- Copy buttons confirm with a check mark and **clear the clipboard after 30 seconds** by default (15 s, 1 min, 2 min or Never in **Settings → Vault → Clear copied secrets after**)

## Security model

- **Crypto:** the master password is stretched with Argon2id (64 MiB, 3 passes) into a key that wraps a random 256-bit vault key. A random recovery key (shown once, when you create the vault) wraps the same vault key. The database is sealed with XChaCha20-Poly1305 using a fresh random 24-byte nonce on every save, and its header is authenticated.
- **Keys in memory only:** the vault key and the decrypted database exist only in the app process while unlocked and are zeroized on lock. Passwords are zeroized on the Rust side after use (the JavaScript string that carried them cannot be wiped).
- **Locking:** manual, a customizable panic shortcut (default `Ctrl+Alt+L`), idle timeout (default 5 minutes), when the window is closed to the tray, and (Windows) when the PC locks (Win+L), sleeps or a remote session disconnects. Revealed passwords hide again after 30 seconds (configurable) or when the window loses focus.
- **Clipboard:** copied secrets are kept out of Windows clipboard history and the cloud clipboard, and the clipboard is wiped after the time you choose (30 seconds by default; only if it still holds that secret).
- **Quick search (optional):** a system-wide hotkey (default `Ctrl+Alt+K`, off until you turn it on) opens a small search window; *Enter* copies the main secret, *Ctrl+Enter* the username, *Alt+Enter* opens the entry. It never displays secrets.
- **Windows Hello unlock (experimental, off by default):** a Windows Hello key protects the vault key, so unlocking needs a Hello prompt instead of typing the password. The master password stays the root secret: it is required again after a backup restore or if Hello is reset. Treat it as a convenience, not a stronger lock.
- **Recovery kit:** when you create a vault you can print a one-page recovery kit (the key is shown once and never stored).
- **AI & search:** vault content is never sent to AI (chat, actions, autocomplete) and is excluded from global search and the graph.
- **Brute force:** repeated wrong passwords are throttled in-app; offline resistance comes from the Argon2 cost, so choose a long, unique password. Anyone who gets a copy of `vault.nqdb` can only try to guess it offline.
- **Not covered:** a compromised OS (keylogger, memory dump while unlocked) defeats any in-app encryption, and images pasted into notes are stored outside the vault.

**Losing both your master password and recovery key means the vault cannot be recovered.**

## Vault Sync with Google Drive

Optional and **off until you turn it on**. It keeps one vault in step across your PCs using your own Google Drive.

- **Turn it on:** click the cloud button in the title bar, or choose **Use my vault from Google Drive** on the vault setup screen, and sign in with Google. Manage it later in **Settings → Vault → Sync**.
- **Encrypted before upload:** the vault is sealed on your PC first, so Google only ever stores encrypted data. Notiq can see only its own app-data folder in your Drive (the `drive.appdata` scope), not your other files.
- **No lost edits:** if the same item was changed on two PCs, the newer version is kept and the other is saved in its history, with one notification saying which items and devices.
- **Two different vaults:** this PC's vault is backed up first. Then you can add its items to the Drive vault, switch to the Drive vault, or choose *Keep this PC separate* (sync stays off).
- **Master password changes:** the new password works on every PC. If two PCs change it at about the same time, the later change wins.
- **Pause / Resume:** *Pause* stops syncing on this PC; *Resume sync* starts again. If your vault is no longer in Google Drive, Notiq asks before uploading it again.
- **Attachments sync too:** up to 5 MB per file, 25 MB per vault and 20 files per item.
- **Disconnect any time:** your data stays in your Drive until you delete it (Google Drive → Settings → Manage apps).
- **For developers:** the Google client ID and secret are read at build time from the `NOTIQ_GOOGLE_CLIENT_ID` and `NOTIQ_GOOGLE_CLIENT_SECRET` environment variables (see `src-tauri/src/sync/gdrive.rs` and the release workflow). A build without them hides the *Connect Google Drive* option. Never commit real values.

## Browser autofill

The `browser-extension/` folder holds a Chrome / Edge / Brave (and Firefox) extension that works with your *Login* entries through a local native-messaging bridge. Passwords never leave your computer: the vault must be unlocked and **every fill and every save is approved inside Notiq**.

- **Auto-detect and fill:** on login pages a small Notiq key icon appears inside the username / password fields. Click it (or press `Alt+Shift+L`, or use the toolbar button) and approve in Notiq to fill the form, including the current 2-step code. Nothing is requested until you click. If Notiq is closed, the extension starts it in the tray.
- **Small approval window:** the approval appears in a small, always-on-top Notiq window centred on your screen, showing the site that asks. If the vault is locked you unlock it right there (master password, or Windows Hello when it is on), then pick the account and press *Allow*. The main Notiq window is never brought forward (it can stay in the tray), and the browser gets the focus back as soon as you answer. Esc or *Deny* refuses.
- **Fewer prompts:** tick *Allow this site for 5 minutes* in the approval window and further fills on that exact site need no prompt at all, not even a window flash (until the time runs out or the vault locks). With several saved logins for a site, a small chooser in the page lets you pick the account.
- **Save from the browser:** when you sign in or sign up, a "Save login to Notiq?" card appears (or "Update password in Notiq?" on change-password forms). The same small Notiq window asks you to confirm and stores it in your vault's `Logins` folder. *Never for this site* is remembered and can be undone from the extension popup.
- **Sign-up helper:** on new-password fields the icon offers *Generate strong password* and fills both the password and the confirmation field.
- **Toolbar popup:** lists this site's logins (title and username only). Click one to fill it, or copy its username, password or 2FA code. The app does the copying and clears it later; there is also *Open in Notiq*.
- **Right-click menu:** on any field, **Notiq ▸ Fill login · Fill 2FA code · Fill identity ▸ · Generate password**.
- **Identities:** your **Identity** entries (name, email, phone, address 1/2, city, state, PIN/ZIP, country) are filled into address and checkout forms. Notiq always asks which identity and shows the site.
- **Custom fields:** a login's custom fields (like a bank's *Customer ID*) are filled when the page has a field with the same name.
- **Choose what to update:** when saving, if several logins share a username you pick which to update, or save a new one.
- **Smarter forms:** a 2FA code asked on its own page, generated passwords that follow the site's rules, split one-time-code boxes, login iframes of the same site, and username-first flows are handled.
- **Safer matching:** a login saved for a site matches that site and its subdomains, never a whole public suffix (such as `co.uk`); one login can list several websites; and a request from a look-alike address (`paypa1.com`, punycode tricks) is refused and reported inside Notiq.
- **Status and Repair:** **Settings → Vault → Browser autofill** shows whether the native host is registered for each browser and when the extension last connected, with a **Repair** button.
- **Install:** the extension files ship inside Notiq. Open **Settings → Vault → Browser autofill → Install the browser extension**: it shows the folder, has buttons that open the folder and your browser's extensions page, and walks you through *Developer mode → Load unpacked* (until the store listings are live; Firefox: temporary add-on from the release package). Packages and the build script are documented in [`browser-extension/README.md`](browser-extension/README.md); the extension has its own [privacy policy](docs/extension-privacy.html). The extension reads pages to find login fields, so Chrome shows an "all websites" permission note.
