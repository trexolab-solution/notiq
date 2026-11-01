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
  The popup header shows whether Notiq is running and whether the vault is locked.
- **This site's logins in the popup** (Notiq 0.9.0+): under the Fill button the popup lists the logins saved for
  the current tab's site (title and username only; never the whole vault, never a password or code), with a
  filter box. Click a login to fill it (Notiq asks you to Allow as usual). Each row also has buttons to **copy the
  username**, **copy the password**, **copy the 2FA code** (greyed out when none is saved) and **open it in
  Notiq**. Copies are made by the Notiq app itself: the value never passes through the extension, it is kept out
  of Windows clipboard history, and Notiq clears it after the time set in Notiq → Settings → Vault → **Clear
  copied secrets after** (15 s, 30 s (default), 1 min, 2 min or Never; only if the clipboard still holds it).
  Copying a password or code needs your Allow (or the site's 5-minute trust), like a fill; when Notiq shows its
  approval window the browser may close the popup, the copy still happens. Keyboard: type to filter, **↓** moves
  into the list (↑/↓ between logins in the same column, ←/→ along a row, ↑ on the first login back to the filter),
  **Enter** in the filter fills the first login. When Notiq is locked, not running, or older than 0.9.0 the list
  says so ("Unlock Notiq…", "Open Notiq…", "Update Notiq…") instead.
- **Save a new login:** sign in or sign up with a password Notiq doesn't know yet. When the next page no longer shows
  a password field, a card in the top-right corner asks **Save login to Notiq?** with the site and username (never
  the password). **Save** → approve in Notiq → "Saved to Notiq", "Password updated in Notiq" or "Already saved".
  **Not now** (or Esc, or 25 seconds without touching it) drops the offer; **Never for this site** stops offers
  for that site. Sign-up forms (`autocomplete="new-password"`) are offered too.
- **Generate a strong password (sign-up / change-password):** on a new-password field (`autocomplete="new-password"`,
  or a form with a confirm field) the icon opens a small menu: **Generate strong password** fills the new password
  and its confirm field with a 20-character password (upper/lower/digits/symbols, no look-alikes like `I l 1 O 0`),
  made in the extension with `crypto.getRandomValues`. It follows the site's own limits: `maxlength` / `minlength`,
  the `passwordrules` attribute (`required`, `allowed`, `minlength`, `maxlength`, `max-consecutive`) and a simple
  `pattern` (one character class with a length, e.g. `[A-Za-z0-9]{8,16}`; any pattern is still checked against the
  result). It then makes the longest password allowed up to 20 characters (never under 12 unless the site's maximum
  is lower) from the allowed characters with every required class, and the menu says so. Rules that can't be met
  fall back to the default password (still no longer than the site's maximum) with a warning. If a page script
  still changes the value, Notiq retries once at the length the page kept, or clears the fields with an error, so
  the saved password is always the one the site has. Nothing is sent anywhere at that point: once you submit the
  form the usual **Save login to Notiq?** offer appears. **Show** reveals it inside Notiq's own overlay only.
  **Fill saved login** is offered too when the form has a current-password field. Arrow keys / Enter / Esc work.
- **Change-password forms** (current + new + confirm): the new password is captured and the offer reads
  **Update password in Notiq?**.
- **Split code boxes:** when Notiq returns a one-time code and the page has 4–8 single-character code boxes, the
  code is typed into them digit by digit and the last box is focused.
- **2FA code on its own page:** when the code is asked on a separate page (a one-time-code field, or split code
  boxes, and no password field), that field gets the key icon too (for split boxes it sits just after the last box).
  Clicking it asks Notiq for the matching login's current TOTP code only (`intent:"code"`): the same approval and
  5-minute trust as a fill, only logins with a 2FA secret are offered, and the password is never sent. "No 2FA code
  saved for this site" means none of the matching logins has a 2FA secret.
- **Web components:** login fields inside a page's **open** shadow roots (nested too) are found, filled and
  captured like any other.
- **Multi-step sign-ins** (Google, Microsoft, most SSO pages: username first, then "Next", then the password): fill
  the username page as usual and approve once. Only the username goes into that page; when the password field
  appears (same page or the next page in the same tab, on the same site, within 2 minutes) it is filled too, with no
  second request to Notiq. Nothing is submitted for you. The password waits in the extension's session memory for
  that tab only and is dropped once used, after 2 minutes, when the tab closes or leaves the site, on a new fill, or
  when Notiq reports the vault locked.
- **Custom fields:** a login's custom fields (for example a bank's "Customer ID", "Membership No." or "PIN") are
  filled with the login, from the in-page icon, the toolbar and the password step of a multi-step sign-in. A field
  gets one when its label, `aria-label`, `aria-labelledby` text, placeholder, `name` or `id` names it. Names are
  compared without case, accents, spaces or punctuation, camelCase is split, `no` / `num` / `nbr` / `nr` / `#` mean
  "number" and filler words ("Enter your …") are ignored, so "Customer ID" matches `name="customerId"`,
  `id="customer_id"`, a "Customer Id:" label or an "Enter your customer ID" placeholder, and "Membership No." matches
  `membershipNumber`. Only whole names match: "PIN" never fills "PIN code". Only text-like fields of the login's own
  form (the whole frame for formless pages) are used, never the username / password / 2FA fields of that fill,
  one-time-code, new-password or card fields, hidden or read-only fields, or a field that already holds a value
  (unless it is the one you clicked). Secret custom fields are filled only on the login's own site, under the same
  rule as its password. Try it on `test-pages/custom-fields.html`.
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
- **Identities (address / contact forms):** add one or more **Identity** entries in Notiq (New > Identity, e.g.
  "Home", "Office": full name, email, phone, address lines 1–2, city, state, PIN/ZIP, country). Fields are found by
  their `autocomplete` tokens first (`name`, `given-name` / `family-name`, `email`, `tel`, `address-line1/2`,
  `street-address`, `address-level2` (city), `address-level1` (state), `postal-code`, `country` / `country-name`,
  `<select>` lists included), then by their labels, names and placeholders (Indian forms too: "PIN code", "Pincode",
  "Mobile number", "Flat, House no., Building", "Area, Street, Sector, Village", "Town/City"). A form that looks like
  an address or contact form (three kinds of field, one of them an address or phone field; never a form with a
  password field) gets the Notiq icon in its text fields. Clicking it lists your identity titles when Notiq is
  unlocked (`{op:"identities"}`, titles only), or goes straight to Notiq otherwise; Notiq **always** asks you to pick
  the identity and shows which site gets it (no "allow for 5 minutes"). Then name (split into first / last name where
  the form wants that), email, phone (the last 10 digits for a 10-digit mobile field), both address lines (a single
  address box gets line 1 when the form also has a locality / line-2 field), city, state and country (matched
  against the form's lists, by name or ISO code) and PIN/ZIP are filled into that form only. Landmark, company,
  alternate phone, hidden, invisible, read-only and disabled fields are never touched. Same https / same-site frame
  rules as cards.
- **Right-click menu** on any editable field: **Notiq ▸ Fill login · Fill 2FA code · Fill identity ▸ (Home / Office …,
  Choose identity…) · Generate password**. Each item does what the matching icon does, for the field you
  right-clicked, in that frame only (the background re-checks that the frame is on the top page's site; frames from
  other sites have no Notiq script at all), with the usual approval in Notiq. Generate password fills that field
  (and its confirm field on a sign-up form) locally. The identity titles are loaded when the menu opens (Firefox
  `menus.onShown`; on Chrome / Edge when you right-click a field, at most every 15 s, so a just-added identity shows
  the next time) and only while Notiq is unlocked; otherwise **Choose identity…** opens the in-page chooser, where
  Notiq can unlock. Titles live in session memory only and are dropped when Notiq reports the vault locked. An
  older Notiq shows "Update Notiq to use this." for identities.

### Settings (toolbar popup)
- **Offer to save new logins** (on by default).
- **Show Notiq icon on login fields** (on by default). Turning it off keeps the toolbar button and shortcut (the shortcut then opens the popup) (and
  also hides the focus suggestion).
- **Suggest on field focus** (off by default; turn it on in the popup): the **Fill with Notiq** button under a focused login field.
- **Never save for these sites:** the sites you chose "Never for this site" on; click × to allow offers again.
- **Save and use passkeys with Notiq (experimental)** (off by default): see [Passkeys (experimental)](#passkeys-experimental).

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
- `contextMenus` — the **Notiq** entry in the right-click menu of editable fields (Firefox: `menus`, same API).
- Optional host access to `https://*/*` and `http://localhost/*` — asked for only when you turn on **Save and use
  passkeys with Notiq (experimental)**, and given back when you turn it off. The browser needs it to register the
  passkey page scripts (`scripting.registerContentScripts`); it covers the same sites the content script already
  runs on.
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
  page's site: the same host, or under the top host's registrable domain per the Public Suffix List (so
  `login.example.co.uk` belongs to `www.example.co.uk`, but `evil.github.io` never belongs to `me.github.io`; IP
  addresses and `localhost` only match themselves). The background re-checks the frame against the tab's real URL,
  always asks Notiq for the **top page's** host, and returns the login only to the frame that asked.
- Toolbar button / Alt+Shift+L (icon off): first a probe **without any secret** runs in every frame and reports
  only its origin, its parents' origins and whether it has login fields; the login is then injected only into the
  frames that pass the same-site rule (by `documentId` on Chromium, so a frame that navigated meanwhile gets
  nothing; the injected code re-checks its origin either way).
- Multi-step sign-ins: a held password is dropped as soon as Notiq reports the vault locked or is closed (checked
  before every hand-out and whenever the popup opens).
- Generated passwords exist only in the page's fields and the extension's memory until you submit the form.
- Popup list: only the toolbar popup can ask for it (a page's content script cannot), only for the active tab's
  top host taken from the tab's URL, only while the vault is unlocked, and the app returns only the titles and
  usernames of the logins that match that site (the same data as the "several logins" chooser). It needs no Allow
  for that reason; a locked vault answers `locked` and lists nothing. Row actions (fill, copy, open) are accepted
  only for an account from that tab's latest list (10 minutes) for the same host. Copied secrets never reach the
  extension: Notiq copies them and only answers `{ok, copied, clearAfter}`.

## Protocol with the app (native messaging)
- `{op:"fill", host}` → `{ok:true, username, password, title, code?, fields?}` (`fields`, Notiq 0.9.0+: that
  login's custom fields `[{name, value, secret}]`, at most 20, re-validated here one by one), or `{choose:[{account, title, username}]}`
  when several logins match (no secrets; at most 20 entries, strictly validated, shown as plain text), or `{error}`.
- `{op:"fill", host, intent:"code", account?}` (a separate 2FA page) → `{ok:true, username, title, code}` (never the
  password; the extension also drops anything else an older app sends), or `{error:"no_code"}` when no matching
  login has a 2FA secret. Any other `intent` is refused (`bad_request`).
- `{op:"fill", host, account}` → the chosen login. The extension only sends an `account` that the app offered for
  that tab and host in the last 2 minutes, once.
- `{op:"save", host, url, username, password, title}` → `{ok:true, status:"saved"|"updated"|"unchanged"}` or `{error}`.
- `{op:"ping"}` → `{ok:true, appVersion, locked, protocol, minProtocol}` (an app before 0.9.0 answers `{ok:true}`).
  The popup shows "Notiq is locked", "Update Notiq" or "Update the extension" from it.
- Every request also carries `ext` (this extension's version) and `protocol` (`PROTOCOL` in `shared.js`). The app
  has its own `PROTOCOL` and `MIN_EXTENSION_PROTOCOL` (`src-tauri/src/autofill.rs`); they are compatible when
  `app protocol >= MIN_APP_PROTOCOL` (extension side) and `extension protocol >= MIN_EXTENSION_PROTOCOL` (app side,
  which otherwise answers `{error:"extension_outdated", appVersion, minProtocol}`). A missing `protocol` means 1.
  Bump `PROTOCOL` on both sides together (a test on each side checks they agree); raise a minimum only when older
  peers would misbehave.
- Toolbar popup (Notiq 0.9.0+; an older app answers `{error:"unknown_op"}` and the popup says to update Notiq).
  None of these starts Notiq:
  - `{op:"list", host}` → `{ok:true, accounts:[{account, title, username, totp}]}` (at most 50; `totp` = a 2FA
    secret is saved) or `{error:"locked"|…}`. No prompt; unlocked vault only.
  - `{op:"copy", host, account, what:"username"|"password"|"code"}` → `{ok:true, copied, clearAfter}` (seconds,
    0 = never) or `{error:"denied"|"locked"|"stale"|"no_code"|…}`. Notiq copies the value; password and code are
    approved like a fill (prompt that can unlock, or the site's trust window), the username needs an unlocked vault.
  - `{op:"open", host, account}` → `{ok:true}`: Notiq comes to the front and opens that entry (asking to unlock
    first if needed).
- `{op:"fill_identity", host, origin, account?}` → `{ok:true, title, name, email, phone, address1, address2, city, state,
  postal, country}` (strictly validated: strings within caps, at least one set) or `{error}` (`no_identity`, `denied`,
  `locked`, …; `unknown_op` from a Notiq before identities). Same origin rule as `fill_card`; `account` (from
  `identities`) only pre-selects the identity in Notiq's picker.
- `{op:"identities"}` → `{ok:true, identities:[{account, title}]}` (at most 20, titles are entry file names, no values)
  or `{error:"locked"}`. Answered without any window, only while the vault is unlocked; never starts Notiq.
- Passkeys (experimental; only while the setting is on; never start Notiq; an older app answers `unknown_op` and the
  browser handles the request):
  - `{op:"passkey_create", origin, rpId, rpName, user:{id, name, displayName}, clientDataJSON, algs, exclude}` →
    `{ok:true, credentialId, attestationObject, authenticatorData, publicKey, alg:-7}` or `{error}` (`excluded`,
    `denied`, `locked`, `bad_rp_id`, …). Ids and binary values are base64url without padding.
  - `{op:"passkey_get", origin, rpId, clientDataJSON, allow}` → `{ok:true, credentialId, authenticatorData,
    signature, userHandle}` or `{error}` (`no_passkey`, `denied`, …).
- `{op:"theme"}` → `{ok:true, theme:{id, mode:"dark"|"light", bg, bgSecondary, bgTertiary, text, textMuted, border,
  primary, primaryText, danger, success}}` (colours `#rrggbb`), or `{ok:true, theme:null}` when the app has none.
  Never launches the app. `{error:"unknown_op"}` from an older app is treated as no theme; when the app is
  unreachable the cached theme is kept.

## Passkeys (experimental)
Off by default. Turn on **Save and use passkeys with Notiq (experimental)** in the popup (the browser asks for the
optional host access above), then reload open pages. Passkeys are then saved in, and used from, your Notiq vault:

- **Creating a passkey** (`navigator.credentials.create`) on a site: Notiq asks **Save a passkey for github.com?**,
  with the account name and a choice of the site's saved login to keep it on (the one with the same user name is
  pre-selected) or **New login** (made in the `Logins` folder, without a password). **Not now** lets the browser
  handle it instead. If the site lists a passkey Notiq already holds for that account, Notiq says so and the site
  gets `InvalidStateError` (nothing new is saved).
- **Signing in with a passkey** (`navigator.credentials.get`): Notiq asks **Sign in to github.com with a passkey?**
  and lists only the passkeys saved for exactly that RP ID (and, when the site names the credentials it accepts,
  only those). With none, Notiq shows nothing and the browser's own passkey dialog opens.
- Every create and sign-in needs that approval in Notiq; there is no "allow for 5 minutes". A locked vault is
  unlocked in the same window first. Unlocking / pressing Allow is the user verification.
- **Deny, Notiq closed or locked and left locked, no matching passkey, an error:** the page's request goes to the
  browser's own implementation with the original options, so Windows Hello, a phone or a security key still work.
- Notiq is asked only right after a real click or key press on the page (transient user activation), never on
  page load; passkey autofill requests (`mediation: "conditional"`) and requests for a roaming authenticator
  (`authenticatorAttachment: "cross-platform"`) always go to the browser.
- In Notiq, a login's passkeys are listed on the login (site, user name, date) with a delete button. The private
  key is never shown. Deleting one there doesn't remove it from the site; remove it in the site's security
  settings too.

How it works and what is checked:
- `passkey-page.js` runs in the page's main world (only while the setting is on) and wraps
  `navigator.credentials.create` / `get` for `publicKey` requests. It posts the request as plain data to
  `passkey-bridge.js` (the extension's isolated world, same window only: `event.source` is the window itself and
  `event.origin` its own origin), which checks the user gesture and the message shape and hands it to the
  background.
- The background takes the origin from the frame's real URL, never from the page: https on a domain or
  `http://localhost` (no IP addresses), the active tab only, the top frame or a **same-origin** subframe whose every
  ancestor has that origin (other frames, including same-site cross-origin ones, use the browser's dialog). The RP
  ID must be the page's host or a registrable parent domain of it, never a public suffix (`github.com` for
  `www.github.com`; never `com`, `co.uk` or `github.io`; Public Suffix List). The background builds
  `clientDataJSON` (`type`, `challenge`, `origin`, `crossOrigin:false`) itself. One request per tab at a time.
- The app checks it all again (`src-tauri/src/passkey.rs`): the origin, the RP ID rule with its own copy of the PSL
  table, and that `clientDataJSON` names this origin and ceremony. It makes the key pair (ES256 / P-256), keeps the
  private key in the vault only (PKCS#8, on the Login entry's `passkeys` list), and signs `authenticatorData ‖
  SHA-256(clientDataJSON)` itself. The extension only ever sees public keys, attestation objects and signatures.
- Encodings: attestation format `none` (canonical CBOR `{fmt, attStmt:{}, authData}`), COSE EC2 key, AAGUID all
  zeros, `signCount` always 0, flags UP + UV, plus **BE + BS** (backup eligible and backed up: the key lives in your
  vault file, which you may back up or sync; there is no counter to keep in step across devices because it stays 0).
  `getTransports()` answers `["hybrid", "internal"]`, `authenticatorAttachment` is `platform`, `credProps` answers
  `{rk: true}` when asked; other extensions (PRF, large blob, …) are ignored.

Limits (experimental): verified with unit tests and a headless-Chromium run (`node browser-extension/test/e2e-passkeys.mjs`,
which mocks the Notiq app) only; **not yet tried against real sites** such as webauthn.io, GitHub or Google. Only
ES256 (a site that doesn't accept `-7` gets the browser's dialog). No attestation other than `none` (a site that
demands `direct` attestation still gets `none`). Aborting a request (`AbortSignal`) rejects it on the page but does
not close Notiq's window. Firefox: needs main-world content script registration (Firefox 128+) and has no
`location.ancestorOrigins`, so only top frames are served there; not tested. Passkeys are kept with the vault's
other data, so the vault's backups and sync carry them too.

## Known limits
- Login forms in iframes from another site get no icon and aren't captured (anti-phishing). The toolbar button
  fills a frame only when it has the top page's host or is a same-site subframe.
- `https` pages only (plus `http://localhost` and `127.0.0.1` for testing).
- Windows only for now, and developer-mode install only. The extension ID is fixed by the `key` in `manifest.json`;
  the app only accepts that ID.
- In a username-first sign-in that reloads the page between steps, the username typed in step 1 is only remembered
  within the same page (for 5 minutes); if it isn't on the final step, the offer shows "no username".
- Fields inside a page's **closed** shadow roots aren't detected (the page hid them on purpose). Open roots are
  searched up to 6 levels deep and 200 roots per page. The toolbar button / popup fill does not reach into
  shadow roots yet; use the in-page icon there.
- To stay light on busy pages, a page that keeps changing without showing any login, card or code field is
  re-checked less and less often (and not at all on DOM changes after a while) until you focus an input or the
  page's URL changes. A login form revealed only by a CSS class change is picked up when you click into it.

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
<http://localhost:8000/otp.html> is a 2FA step on its own page (one code field and six split boxes).
<http://localhost:8000/shadow-login.html> has logins inside open shadow roots (one component, nested components,
one rendered late) and one in a closed root (ignored).
<http://localhost:8000/identity.html> has an Amazon.in-style address form (labels only), a Shopify-style one
(`autocomplete` tokens), a Flipkart-style one with an address text box, a newsletter box and a login form (no identity
icon on the last two); right-click any field for the Notiq menu.
<http://localhost:8000/custom-fields.html> checks custom fields filled by name (a bank form with Customer ID,
Membership No. and PIN next to the login, a password field labelled "PIN", placeholder-only fields).
<http://localhost:8000/signup-rules.html> has sign-up forms with `maxlength`, `passwordrules`, `pattern`, impossible
rules, and a script that cuts the password.

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
node --test browser-extension/test/*.test.mjs    # unit tests: transforms, zip writer, shared.js (theme, suggestion, same-site, handshake), fillkit.js (generator rules, shadow roots), multi-step hand-off, toolbar fill, code-only fills, identity.js (field classification incl. Indian checkout forms, values)
node browser-extension/build.mjs --psl            # refresh the Public Suffix List copy in shared.js from src/lib/publicSuffixData.ts
```
Only runtime files are packaged (manifest, `shared.js`, `fillkit.js`, `identity.js`, `content.js`, `background.js`, popup, icons,
and the experimental passkey files: `passkeys.js` (background helpers, loaded like `identity.js`), `passkey-page.js` and
`passkey-bridge.js` (registered at run time, so the manifest doesn't name them; `DYNAMIC_SCRIPTS` in `build.mjs`)).
`fillkit.js` holds the content script's pure fill helpers (the site-aware password generator, the open-shadow-root walk)
and loads between `shared.js` and `content.js`. `identity.js` holds the identity helpers (field classification, form
detection, reply validation, value mapping); it loads before `content.js`, and the background loads it after
`shared.js` (`importScripts`; the Firefox build lists it in `background.scripts`). `shared.js` holds
the pure helpers (theme validation, suggestion placement, the Public Suffix List same-site rule, the app handshake); the content script and popup load it first, the Chromium
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
