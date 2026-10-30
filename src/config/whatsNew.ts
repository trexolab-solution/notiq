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

- **New notifications and dialogs** — messages now look like VS Code's: notifications with icons, action buttons and expandable details, a bell in the status bar with a history and *Do not disturb*, and one consistent dialog design for confirmations and approvals.
- **Settings is now a tab** — open it with \`Ctrl+,\` and work in a full page like VS Code's: search every setting, jump between sections, see which settings you've changed and reset any of them with one click. Settings also appear in the command palette (\`Ctrl+Shift+P\`). The Vault settings are grouped into Locking, Storage, Backup, Quick unlock, Quick search and more.
- **Browser extension included** — the Notiq Autofill extension now ships inside the app. Open **Settings → Vault → Browser autofill → Install the browser extension** for the folder, buttons that open your browser's extensions page, and the *Developer mode → Load unpacked* steps.
- **Back up your vault** — export one encrypted \`.nqbackup\` file (Settings → Vault → Backup) and restore it on a new PC from the vault setup screen. Notiq reminds you when it's time. Nothing is uploaded, ever.
- **More than passwords** — new **Card**, **Wi-Fi** and **Recovery codes** entries, custom fields on every entry, extra websites on a login, **file attachments** and **version history** (the last 10 versions of each entry, restorable). All of it stays inside the one encrypted file.
- **Vault health & import** — an offline check for weak, reused and old passwords, and import from Chrome, Bitwarden or KeePass CSV files.
- **Stronger privacy on Windows** — copied secrets stay out of clipboard history, the vault locks when you lock your PC or it sleeps, and revealed passwords hide on their own. Optional **quick search** (\`Ctrl+Alt+K\`) and an experimental **Windows Hello** unlock are off until you turn them on.
- **Autofill that fits Notiq** — approvals now open in a small separate window instead of bringing the whole app forward, the extension suggests \`Fill with Notiq\` when you click a login field, and its popup and in-page buttons follow your Notiq theme. Update the extension from **Settings → Vault → Browser autofill** to get it.
- **Faster unlock and fill** — unlock with Windows Hello or your master password right in the small autofill window and the login fills in one step. \`Alt+Shift+L\` fills the focused login field, the unlock screen opens with the method you used last, and the extension installs from the app again.
- **Cards and two-step sign-ins** — fill a saved **card** on checkout pages (you pick the card in Notiq every time; only the last four digits are shown), and sign-ins that ask for the username first, then the password, fill both steps after one approval. The first fill after unlocking no longer fails with *"Notiq isn't running"*, and the autofill window uses the same unlock screen as the app, with **PC sign-in**. Update the extension from **Settings → Vault → Browser autofill** to get it.
- **Cleaner recovery kit** — the printable recovery kit has a new one-page layout.
- **Smarter browser autofill** — a Notiq icon on sign-up fields can generate a password, a 5-minute "allow this site" option means fewer prompts, an in-page chooser handles several accounts, and Notiq starts itself from the browser when it's closed. Look-alike sites are blocked and reported. A new **Browser autofill** panel in Settings shows the connection status and has a **Repair** button.
- **Safer matching** — a login saved for \`co.uk\`-style suffixes no longer matches every site under it.
- **Housekeeping** — the app checks for updates every hour while it runs, and developer builds no longer share data with an installed Notiq.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
