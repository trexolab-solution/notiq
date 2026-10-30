# Notiq Autofill (Chrome / Edge / Brave)

Fills and saves logins with your Notiq vault. Passwords never leave your computer: the extension talks to the
running Notiq app through a local native-messaging bridge, and **every fill and every save needs your approval
inside Notiq** (the vault must be unlocked).

The approval appears in a **small, always-on-top Notiq window** centred on your screen; the main Notiq window is
not brought forward and can stay in the tray. The window shows the site that is asking (check it), lets you unlock a
locked vault right there (master password, or Windows Hello when it is on), pick the account and press **Allow**, or
confirm a save. Esc / **Deny** / **Not now** refuses. When you answer, the window disappears and the browser gets
the focus back. A site you allowed for 5 minutes fills without any window appearing.

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
- **Suggestion on focus** (off by default; enable it in the popup): when you click or tab into a detected username/email/password field, a small
  **Fill with Notiq** button (with the `Alt+Shift+L` hint) appears under it. It shows no usernames or other vault
  data: clicking it does exactly what clicking the key icon does, and Notiq still asks you to Allow. It never takes
  focus from the field; press **↓** to reach it from the keyboard (Enter fills, ↑ goes back), **Esc** hides it for
  that field until the page is reloaded, typing or clicking elsewhere hides it. It is not shown on one-time-code,
  search or other non-login fields, in other sites' iframes, or when the icon is turned off.
- **Fill from the toolbar:** click the Notiq toolbar icon → **Fill login for this site**. Or press `Alt+Shift+L` on a page to fill right away, as if you had clicked the Notiq icon of the focused login field (the first one if none is focused).
  The popup header shows whether Notiq is running.
- **Save a new login:** sign in or sign up with a password Notiq doesn't know yet. When the next page no longer shows
  a password field, a card in the top-right corner asks **Save login to Notiq?** with the site and username (never
  the password). **Save** → approve in Notiq → "Saved to Notiq", "Password updated in Notiq" or "Already saved".
  **Not now** (or Esc, or 25 seconds without touching it) drops the offer; **Never for this site** stops offers
  for that site. Sign-up forms (`autocomplete="new-password"`) are offered too.
- **Generate a strong password (sign-up / change-password):** on a new-password field (`autocomplete="new-password"`,
  or a form with a confirm field) the icon opens a small menu: **Generate strong password** fills the new password
  and its confirm field with a 20-character password (upper/lower/digits/symbols, no look-alikes like `I l 1 O 0`),
  made in the extension with `crypto.getRandomValues`. Nothing is sent anywhere at that point: once you submit the
  form the usual **Save login to Notiq?** offer appears. **Show** reveals it inside Notiq's own overlay only.
  **Fill saved login** is offered too when the form has a current-password field. Arrow keys / Enter / Esc work.
- **Change-password forms** (current + new + confirm): the new password is captured and the offer reads
  **Update password in Notiq?**.
- **Split code boxes:** when Notiq returns a one-time code and the page has 4–8 single-character code boxes, the
  code is typed into them digit by digit and the last box is focused.
- **Multi-step sign-ins** (Google, Microsoft, most SSO pages: username first, then "Next", then the password): fill
  the username page as usual and approve once. Only the username goes into that page; when the password field
  appears (same page or the next page in the same tab, on the same site, within 2 minutes) it is filled too, with no
  second request to Notiq. Nothing is submitted for you. The password waits in the extension's session memory for
  that tab only and is dropped once used, after 2 minutes, when the tab closes or leaves the site, on a new fill, or
  when Notiq reports the vault locked.
- **Several logins for one site:** Notiq sends back just their titles and usernames; pick one from the list next to
  the icon (or in the toolbar popup), then approve in Notiq as usual. Esc cancels.
- **Login iframes on the same site** (for example `login.example.com` inside `www.example.com`) get the icon, fill
  and save offer too. Iframes from any other site are ignored completely.
- A login matches when the entry's website equals the page's host or a parent domain of it
  (`login.example.com` ↔ `example.com`).
- **Payment cards:** on a checkout page the card number field gets the same key icon (fields are found by their
  `cc-number` / `cc-exp` / `cc-exp-month` / `cc-exp-year` / `cc-name` / `cc-csc` autocomplete tokens or by their
  names and labels; month / year dropdowns work too). Clicking it sends `{op:"fill_card", host, origin}`; Notiq
  **always** asks you to pick a card (shown as `•••• 4242`), with no "allow for 5 minutes" shortcut, and only then
  fills number, expiry, cardholder name and the security code if you stored one. Only https pages (or localhost),
  and only the page itself or a same-site iframe: card fields inside another site's iframe (Stripe, Adyen, …) are
  never filled.

### Settings (toolbar popup)
- **Offer to save new logins** (on by default).
- **Show Notiq icon on login fields** (on by default). Turning it off keeps the toolbar button and shortcut (the shortcut then opens the popup) (and
  also hides the focus suggestion).
- **Suggest on field focus** (off by default; turn it on in the popup): the **Fill with Notiq** button under a focused login field.
- **Never save for these sites:** the sites you chose "Never for this site" on; click × to allow offers again.

### Theme
The popup and everything the extension draws on pages (key icon, suggestion, save card, menus) use the colours of
the theme you picked in Notiq. The background asks the app for it (`{op:"theme"}`, which carries no site or page
data and never starts Notiq) when the service worker starts, when the popup opens, and at most once a minute when
you first use the in-page UI on a page (never on page load). The reply is strictly validated (`#rrggbb` colours, a
`dark`/`light` mode, a short id) and cached in `chrome.storage.local`; it is applied only as CSS custom properties,
one validated value at a time. Without a theme from the app (older app, not running yet) the extension uses Notiq's
default dark or light colours, following your system setting.

## Permissions, and why
- `nativeMessaging` — talk to the Notiq app on this computer. This is the only channel anything travels over.
- `storage` — your settings above, the cached app theme, and (in memory-only session storage, never on disk) a just-submitted
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
- Iframes: the script runs in every frame but stops at once unless the frame and all its parents are on the top
  page's site (same host or a subdomain of its last two labels, or last three for `example.co.uk`-style names;
  IP addresses only match themselves). The background re-checks the frame against the tab's real URL, always asks
  Notiq for the **top page's** host, and returns the login only to the frame that asked.
- Generated passwords exist only in the page's fields and the extension's memory until you submit the form.

## Protocol with the app (native messaging)
- `{op:"fill", host}` → `{ok:true, username, password, title, code?}`, or `{choose:[{account, title, username}]}`
  when several logins match (no secrets; at most 20 entries, strictly validated, shown as plain text), or `{error}`.
- `{op:"fill", host, account}` → the chosen login. The extension only sends an `account` that the app offered for
  that tab and host in the last 2 minutes, once.
- `{op:"save", host, url, username, password, title}` → `{ok:true, status:"saved"|"updated"|"unchanged"}` or `{error}`.
- `{op:"ping"}`.
- `{op:"theme"}` → `{ok:true, theme:{id, mode:"dark"|"light", bg, bgSecondary, bgTertiary, text, textMuted, border,
  primary, primaryText, danger, success}}` (colours `#rrggbb`), or `{ok:true, theme:null}` when the app has none.
  Never launches the app. `{error:"unknown_op"}` from an older app is treated as no theme; when the app is
  unreachable the cached theme is kept.

## Known limits
- Login forms in iframes from another site get no icon and aren't captured (anti-phishing). The toolbar button
  fills a frame only when it has the top page's host or is a same-site subframe.
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
<http://localhost:8000/extra.html> adds a change-password form, a login with split code boxes, a same-site login
iframe and an iframe from `127.0.0.1` (another site, so it is ignored).
<http://localhost:8000/signin-steps.html> is a username-first sign-in whose password step is in place ("Next") or
on a new page ("Next (new page)").

`test/e2e-cdp.mjs` is a developer check (not part of the extension): it loads this folder into Playwright's copy of
Chromium, mocks the Notiq app in the service worker, and drives the test page with real (trusted) input over the
DevTools protocol — `node browser-extension/test/e2e-cdp.mjs` (set `NOTIQ_SHOTS=<folder>` to also save popup and
focus-suggestion screenshots in dark, light and a custom theme) (needs Node 22+, Python, and a Chromium from
`npx playwright install chromium` or `NOTIQ_CHROME=<path to chrome.exe>`).

## Packaging & store submission

### Build the packages
```
node browser-extension/build.mjs [--out dist]     # Node 20+, no dependencies
node browser-extension/build.mjs --check          # validate only, write nothing
node --test browser-extension/test/*.test.mjs    # unit tests: transforms, zip writer, shared.js (theme, suggestion), multi-step hand-off
```
Only runtime files are packaged (manifest, `shared.js`, `content.js`, `background.js`, popup, icons). `shared.js` holds
the pure helpers (theme validation, suggestion placement); the content script and popup load it first, the Chromium
service worker loads it with `importScripts`, and the Firefox build lists it before `background.js`. Output is reproducible
(fixed timestamps). It writes, with a size and SHA-256 table:

| File | Use | Manifest |
| --- | --- | --- |
| `notiq-autofill-<ver>-chrome.zip` | sideload / GitHub release | unchanged, keeps `key` so the ID stays `cfddmbiaaboejbhnijkjodcganjdbcel` |
| `notiq-autofill-<ver>-store.zip` | Chrome Web Store, Edge Add-ons | `key` removed (the store assigns the ID) |
| `notiq-autofill-<ver>-firefox.zip` | Firefox / AMO | `background.scripts` (`shared.js`, `background.js`) instead of `service_worker`, `browser_specific_settings.gecko` (id `autofill@notiq.app`, min 121.0, `data_collection_permissions: none`), `key` removed |

The release workflow (`.github/workflows/release.yml`, job `extension`) builds these on every `v*` tag and attaches
them to the draft release. Bump `version` in `manifest.json` before tagging (stores reject a non-increasing version).

### Load unpacked for development
- Chrome / Edge / Brave: `chrome://extensions` > Developer mode > **Load unpacked** > this folder (the ID is
  fixed by `key`).
- Firefox: `about:debugging#/runtime/this-firefox` > **Load Temporary Add-on...** > pick the `manifest.json` of the
  unpacked Firefox build (extract `-firefox.zip` to a folder; the source `manifest.json` is Chrome-shaped). It is
  removed when Firefox restarts. Restart Firefox once after starting Notiq so the native-messaging bridge is found.

### Submit to the stores
Listing text, permission justifications, privacy answers and screenshot needs are in `store/listing.md`; the
privacy policy page is `docs/extension-privacy.html` (publish with the docs site and use its URL).
- **Chrome Web Store**: <https://chrome.google.com/webstore/devconsole> (one-time developer fee), upload the `-store.zip`.
- **Edge Add-ons**: <https://partner.microsoft.com/dashboard/microsoftedge> , upload the same `-store.zip`.
- **Firefox AMO**: <https://addons.mozilla.org/developers/> , upload the `-firefox.zip`, listed or self-distributed.
  Sources are the plain files in the zip, so no separate source upload is needed.

### After the store assigns an ID
The app only talks to extension IDs it knows. Add the new Chrome Web Store / Edge ID to `EXTENSION_IDS` in
`src-tauri/src/autofill.rs` (the spare slots are marked there; `native_host_reg.rs` builds the bridge manifests from
that list) and ship a new app version, **or**, without rebuilding, put a JSON array of IDs in
`autofill_extensions.json` in the app-data folder, for example `["abcdefghijklmnopabcdefghijklmnop"]`, then restart
Notiq. The Firefox ID `autofill@notiq.app` is already allowed.
