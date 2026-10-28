# Notiq Autofill (Chrome / Edge / Brave)

Fills and saves logins with your Notiq vault. Passwords never leave your computer: the extension talks to the
running Notiq app through a local native-messaging bridge, and **every fill and every save needs your approval
inside Notiq** (the vault must be unlocked).

## Install (developer mode)
1. Start Notiq once (it registers the bridge for Chrome, Edge and Brave).
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`), turn on **Developer mode**, click
   **Load unpacked**, pick this `browser-extension` folder.
3. Restart the browser once so it picks up the bridge.

Updating from 0.1: click the reload button on the extension's card. The browser will ask you to accept the new
"Read and change all your data on all websites" permission (see below) before the new version runs.

## Use
- **Fill from the field:** on a login page a small gold Notiq key appears inside the username/email and password
  fields. Click it, then press **Allow** in Notiq. The icon spins while Notiq waits for you, shows a check when the
  fields are filled, or a short message if something went wrong (vault locked, you declined, no saved login…).
- **Fill from the toolbar:** click the Notiq toolbar icon (or press `Alt+Shift+L`) → **Fill login for this site**.
- **Save a new login:** sign in or sign up with a password Notiq doesn't know yet. When the next page no longer shows
  a password field, a card in the top-right corner asks **Save login to Notiq?** with the site and username (never
  the password). **Save** → approve in Notiq → "Saved to Notiq", "Password updated in Notiq" or "Already saved".
  **Not now** (or Esc, or 25 seconds without touching it) drops the offer; **Never for this site** stops offers
  for that site. Change-password and sign-up forms (`autocomplete="new-password"`) are offered too.
- A login matches when the entry's website equals the page's host or a parent domain of it
  (`login.example.com` ↔ `example.com`).

### Settings (toolbar popup)
- **Offer to save new logins** (on by default).
- **Show Notiq icon on login fields** (on by default). Turning it off keeps the toolbar button and shortcut.
- **Never save for these sites:** the sites you chose "Never for this site" on; click × to allow offers again.

## Permissions, and why
- `nativeMessaging` — talk to the Notiq app on this computer. This is the only channel anything travels over.
- `storage` — your three settings above, and (in memory-only session storage, never on disk) a just-submitted
  login for at most 90 seconds while the save offer is open.
- `activeTab`, `scripting` — the toolbar button fills the tab you clicked it on.
- **Content script on all `https://` sites (plus `http://localhost` / `127.0.0.1`)** — this is what makes the browser
  show "Read and change all your data on all websites". It is needed to spot login fields and notice a submitted
  login on any site you visit. The script only looks at login forms, keeps everything in its own isolated, closed
  UI, makes no network requests, and asks Notiq for nothing until you click.

## Privacy and security
- Credentials only travel between the page and the Notiq app through the local native-messaging bridge, and only
  after you approve in Notiq. There are no servers, analytics or network requests.
- Notiq is never asked anything on page load, so the icon can't reveal to a website whether you have a login saved.
- Only real clicks count: a website can't click the Notiq icon or the Save button for you, and page scripts that
  submit a form on their own don't trigger a save offer.
- The icon and the save card live in a closed shadow DOM the page can't read or restyle; passwords are never put
  into the page, logged, or written to disk by the extension. The save card never shows the password.
- Forms are never submitted automatically.

## Known limits
- Top frame only: login forms inside iframes get no icon and aren't captured (the toolbar button still fills them).
- `https` pages only (plus `http://localhost` and `127.0.0.1` for testing).
- Windows only for now, and developer-mode install only. The extension ID is fixed by the `key` in `manifest.json`;
  the app only accepts that ID.
- In a username-first sign-in that reloads the page between steps, the username typed in step 1 is only remembered
  within the same page (for 5 minutes); if it isn't on the final step, the offer shows "no username".
- Fields hidden inside a page's own shadow DOM aren't detected.

## Trying it locally
```
cd browser-extension/test-pages
python -m http.server 8000
```
Open <http://localhost:8000/login.html>: a simple login, a two-step (username first) login and a sign-up form.

`test/e2e-cdp.mjs` is a developer check (not part of the extension): it loads this folder into Playwright's copy of
Chromium, mocks the Notiq app in the service worker, and drives the test page with real (trusted) input over the
DevTools protocol — `node browser-extension/test/e2e-cdp.mjs` (needs Node 22+, Python, and a Chromium from
`npx playwright install chromium` or `NOTIQ_CHROME=<path to chrome.exe>`).
