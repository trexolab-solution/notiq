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

Safer editing in the vault, a live monitor for your servers, and new themes.

## 📊 Server monitor

- A saved SSH entry now shows its Linux server's **CPU, memory, swap and disks** with live graphs. The **i** button has the host name, system, kernel, uptime and processor.
- It **signs in by itself** while it is in view, with the sign-in method you used last. After a failed sign-in or **Disconnect** it waits for you. A new server's key is only trusted when you say so.

## 🔐 Vault

- A saved item opens **read-only**: press **Edit** to change it. Notiq remembers the section you were on.
- **Recovery codes now live inside the login**, which fixes codes that said they were saved but weren't. Update Notiq on all your computers: an older version drops these codes when it saves that login.
- Replacing a saved password or SSH key asks you to type a confirmation.
- The backup reminder has a new look and can **connect Google Drive**; Vault Sync settings show your Drive storage.

## 🎨 Themes

- Five new themes: GitHub Light, Paper, Catppuccin Latte, Everforest and Graphite.

## 🤖 AI

- Editor suggestions and actions now work with "thinking" models. Setup has a new design and checks that the model really answers.
- With AI off, the editor's own suggestions work. AI never reads the vault.

## 🌐 Browser autofill

- **Passkeys are on by default.** Notiq still asks you every time.
- Fixed a blank window that could appear on top of other apps.

## 🔧 Other

- Server files: trust a new server from a window in the app, set the icon size, clear the filter in one click; paste and Enter work in the file editor.
- The knowledge graph was removed. Wiki links still work.
- Security fixes: locking the vault clears unsaved secrets and closes monitor connections.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
