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

Faster everyday work in the vault.

## 🔐 Vault

- **Select several entries** at once: tick the box that replaces an entry's icon on hover (**Shift+click** ticks a range, **Space** ticks, **Ctrl+A** ticks all), then star, tag, move or trash them together.
- **Copy without opening:** hover a login for *Copy username* / *Copy password*, or select it and press **Ctrl+Shift+U** / **Ctrl+Shift+C**.
- **Undo** after moving an entry to the Trash. A single entry no longer asks first; folders and bulk deletes still do.
- **Sort by Recently used or Most used** (kept on this device only).
- **Paste an \`otpauth://\` link** into the 2-step field and the setup key is filled in for you.
- **Caps Lock indicator** inside every password field.
- **Vault health:** a row now opens the entry with the cursor already in the password (or address) field.

## 🖥️ Terminal

- Apps like Claude Code, tmux and vim can now **copy to your clipboard** from inside the built-in terminal.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
