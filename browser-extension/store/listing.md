# Store listing: Notiq Autofill

Paste-ready text for the Chrome Web Store, Edge Add-ons and Firefox AMO. Requires the **Notiq desktop app v0.7.0 or newer**; say so on every listing.

Privacy policy URL: `https://trexolab-solution.github.io/notiq/extension-privacy.html` (the page is `docs/extension-privacy.html`; use the host the docs are published on).

## Name
Notiq Autofill

## Short description (max 132 chars, Chrome/Edge summary)
Fill and save logins with your Notiq vault. Requires the Notiq desktop app. Nothing leaves your computer.

## Detailed description
Notiq Autofill fills and saves logins with the vault in the Notiq desktop app.

IMPORTANT: this extension does nothing on its own. It needs the free Notiq desktop app (v0.7.0 or newer) installed and running on the same computer, with your vault unlocked.

What it does
- Fill: on a login page a small Notiq key appears in the username and password fields, and focusing one of them shows a small "Fill with Notiq" button under it (no usernames or other vault data are shown before you approve). Click either, approve in the Notiq app, and the fields are filled. The toolbar button and Alt+Shift+L do the same.
- Save: after you sign in or sign up with a new password, a small card asks "Save login to Notiq?". Choose Save, approve in Notiq, done. "Never for this site" stops offers for that site.
- Generate: on sign-up and change-password forms, create a strong random password and have it saved when you submit.
- Several logins for one site: pick one from a short list of titles and usernames.
- Looks like your Notiq app: the popup and the in-page buttons follow the theme you use in Notiq (or your system's light/dark setting).

Privacy by design
- Approvals happen in the Notiq desktop app. Every fill and every save needs your explicit approval there.
- Your logins travel only between the page and the Notiq app on your computer, through the browser's local native-messaging bridge.
- No servers, no accounts, no analytics, no ads, no third parties. The extension makes no network requests.
- It never submits forms for you and never shows the password on the page.

Requirements: Notiq desktop app v0.7.0+ (Windows). Get it at https://github.com/trexolab-solution/notiq

## Single purpose
Fill and save website logins using the user's local Notiq vault, with every fill and save approved in the Notiq desktop app.

## Permission justifications
Paste each into the matching field of the dashboard.

- **nativeMessaging**: The only way the extension talks to the Notiq desktop app on the user's computer. Fill and save requests (site name, and for saves the username/password the user just submitted) go through it to the local app, nowhere else. It also asks the app for its colour theme (a request that carries no site or page data) so the extension's UI matches the app.
- **storage**: Stores four user settings, the user's "never save for these sites" list and the Notiq app's colour theme (local storage), and holds a just-submitted login in session (memory-only) storage for at most 90 seconds while the save offer is open; it is cleared when the tab closes.
- **activeTab**: The toolbar button and Alt+Shift+L fill the tab the user is currently on, only when the user triggers it.
- **scripting**: Used with activeTab to run the fill step in the tab the user clicked the toolbar button on.
- **Content script on all https sites (https://*/*) and http://localhost, http://127.0.0.1**: A login form can be on any site, so the script has to be present on any https page to find login fields and to notice a submitted login for the save offer. It only inspects login forms, makes no network requests, contacts the Notiq app only after a user click or submitted form, and keeps its UI in a closed shadow DOM. http://localhost and 127.0.0.1 are for testing.
- **all_frames: true**: Many sites show the login in an iframe (for example a login subdomain). The script runs in each frame but stops immediately unless the frame and all its parents belong to the same site as the top page; frames from other sites are ignored, and the background re-checks this against the tab's real URL (anti-phishing).
- **Same-site rule**: A saved login matches only when its website equals the page's host or a parent domain of it. Notiq is always asked about the top page's host, never an embedded third-party frame's.

## Data usage / privacy practices answers
- Remote code: **No.** All code ships in the package; no eval, no remote scripts.
- Data collected by the developer: **None.** Developers receive nothing.
- Data sold or transferred to third parties: **No.**
- Data used for purposes unrelated to the single purpose: **No.**
- Creditworthiness/lending use: **No.**
- Analytics, advertising, telemetry: **None.**
- Chrome "data types" boxes: the extension handles *authentication information* and *website content* locally to fill and save logins at the user's request. It does not transmit them to the developer or any third party. Tick only what the form forces you to, and state that it is processed locally and sent solely to the user's own Notiq app.
- Certifications: tick all three (no sale, no unrelated use, no creditworthiness use).
- Firefox AMO: the manifest declares `data_collection_permissions: { required: ["none"] }`; answer "no data collection" in the listing.

## Screenshots checklist
Size **1280x800** (24-bit PNG or JPEG, no alpha), 3 to 5 images. Chrome needs at least 1; Edge 1 to 10; AMO any size, 1 or more.
1. A login page with the Notiq key icon in the fields (use test-pages/login.html or a neutral demo page, never a real brand or real credentials).
2. The Notiq desktop app showing the approval prompt for a fill.
3. The "Save login to Notiq?" card with site and username.
4. The generate-strong-password menu on a sign-up form.
5. The toolbar popup with its settings (or the "Fill with Notiq" suggestion under a focused login field).

Use fake demo data only. Also optional: small promo tile 440x280 (Chrome), marquee 1400x560.

## Icons
- Extension icons: `icon48.png` (48x48) and `icon128.png` (128x128) are in the package. Chrome Web Store also wants the 128x128 store icon (use icon128.png, artwork inside a 96x96 area with 16px transparent padding recommended).
- Edge accepts a 300x300 logo: export one from the Notiq logo.
- Firefox AMO uses the manifest icon (128x128 is fine).

## Categories
- Chrome Web Store: Productivity (or Tools).
- Edge Add-ons: Productivity.
- Firefox AMO: Privacy & Security.

## Review pitfalls to expect
- **Broad host access** (all https sites, all frames): reviewers often ask for narrower patterns or `activeTab` only. Answer: login fields can be on any site and iframes are common; keep the justification above, and point to the privacy policy. Expect a possible request for a demo video or test steps; the reply is below.
- **nativeMessaging needs a desktop app**: reviewers can't test without it. Provide test instructions: install Notiq v0.7.0+ from the GitHub release, start it once (it registers the bridge), unlock the vault, add a login for `localhost`, then open any local test login page. Offer a short screen recording. Say clearly in the description that the app is required.
- **Single purpose** wording must match the description; do not mention unrelated Notiq features (notes, sync) in the listing.
- **Extension ID**: the store build has no `key`, so the store assigns a new ID. Add it to the app (see the README packaging section) or autofill will be refused.
- **Firefox**: AMO asks for source if code is minified or generated. The code is plain, unminified source; the zip is the source. `data_collection_permissions` is required for new add-ons.
- **Remote code / obfuscation**: none; keep it that way.
- **Version bumps**: each store update needs a higher `version` in `manifest.json` than the one published.
