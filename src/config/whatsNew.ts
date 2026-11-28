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

Smarter browser autofill, tidier vault forms and a server monitor that stays connected.

## 🌐 Browser autofill

- Finds the email field on sign-in pages built without a form, such as **Google's**. A login needs a saved username to fill that step.
- Tells **sign-up** forms from sign-ins. Their email field no longer offers a saved login.
- A new **password card** suggests a strong password, with length and character settings.
- A new icon in the field, sized to it and placed beside the page's own buttons.

## 🔐 Vault

- Entry forms and lock screens have a cleaner design. In view mode, clicking a field no longer looks like editing.
- **Attachments** take drag and drop and browse in view mode too. Removing a file needs Edit.
- Screenshot protection can be turned **off for 5 to 20 minutes**; it comes back by itself.
- A change aimed at the empty white box in screenshots after autofill with that protection off.
- Fixed: the window's **X** button now locks the vault (when "Lock when the window is closed" is on), ends trusted sites and disconnects servers.

## 🖥️ Servers

- The server monitor **stays connected** when you switch tabs. It disconnects when you close the tab, lock the vault or hide Notiq. The Disconnect button is gone.
- When a key and a password are both saved, choose "Always use my pick". The sidebar and Connect dialog now follow that choice.

## 🎨 Look

- One new scrollbar design across the app.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
