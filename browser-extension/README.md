# Notiq Autofill (Chrome / Edge / Brave)

Fills logins from your Notiq vault into web pages. Passwords never leave your computer: the extension talks to the
running Notiq app through a local native-messaging bridge, and **every fill needs your approval inside Notiq**
(the vault must be unlocked).

## Install (developer mode)
1. Start Notiq once (it registers the bridge for Chrome, Edge and Brave).
2. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked**, pick this `browser-extension` folder.
3. Restart the browser once so it picks up the bridge.

## Use
Open a site's login page, click the Notiq icon (or press `Alt+Shift+L`) → **Fill login for this site** → press **Allow** in Notiq.
A login matches when the entry's website equals the page's host or a parent domain of it (`login.example.com` ↔ `example.com`).

Windows only for now. The extension ID is fixed by the `key` in `manifest.json`; the app only accepts that ID.
