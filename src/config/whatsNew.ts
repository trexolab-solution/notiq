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

Open the files of this computer on your phone, with the new **Phone Share**.

## 📱 Phone Share

- **One folder, on your Wi-Fi:** turn it on from the **Phone Share** button in the status bar (or the tray menu, or the command palette), scan the **QR code** with your phone and browse the folder in its browser. Any WebDAV app (Solid Explorer, Documents, Files…) works too.
- **A file manager in the browser:** search, sort, list or grid, thumbnails, and a viewer for pictures, **video**, audio, PDF and text. It follows your phone's light or dark theme.
- **Upload from the phone:** add photos and files to the folder (new files only, nothing is replaced). Turn it off in Settings if you prefer.
- **Rename, move, copy and delete (optional):** off by default. Turn it on in Settings, then select items to manage them from the phone.
- **Your own sign-in:** pick a user name and password, or use a random one. Anyone on the network needs it, and the password is never saved to disk.

## 🔧 Fixes

- The remote file manager no longer reconnects (and no longer cuts an upload) when you switch tabs.
- Opening Settings puts the cursor in the search box.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
