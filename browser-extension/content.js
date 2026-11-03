// Notiq Autofill — content script (top frame, plus same-site frames).
//
// 1. Detects login fields and puts a small Notiq icon inside them. Clicking the
//    icon (a real, trusted user click only) asks the background to fill; the
//    Notiq app still asks the user to Allow. Nothing is requested on page load,
//    so the icon never reveals whether the vault has a login for this site.
//    On sign-up / change-password fields the icon opens a small menu that can
//    generate a strong password locally (it is only sent anywhere through the
//    normal save offer after the form is submitted).
// 2. Notices a submitted login and, once the page no longer shows a password
//    field, offers "Save login to Notiq?" (or "Update password in Notiq?" for a
//    change-password form). Saving again needs approval in Notiq.
//
// Frames: the script runs in every frame, but quits at once unless the frame
// and all its ancestors are on the same site as the top page (anti-phishing).
// The background re-checks this from the tab's real URL before any fill.
//
// Everything visible lives in ONE closed shadow root per frame, so page CSS/JS
// cannot read or restyle it. No secret is ever written to the page DOM, a
// page-visible object, window.postMessage or the console.
//
// Private (incognito) windows: nothing at all runs (no icons, menus, fills, save offers) unless Notiq allows
// autofill there (Settings → Vault → Browser autofill; cached by the background in `incognitoAllowed`). When it
// is turned on later, the script starts then.
(() => {
  "use strict";
  const NSP = globalThis.NotiqShared;
  if (NSP && NSP.inPrivateContext()) NSP.whenPrivateAllowed(main);
  else main();

  function main() {
  const NS = globalThis.NotiqShared; // shared.js, loaded just before this file
  const FK = globalThis.NotiqFill;   // fillkit.js, likewise
  if (!NS || !FK) return;

  const isLocalHost = (h) => h === "localhost" || h === "127.0.0.1";
  const pageHost = () => String(location.hostname || "").toLowerCase();
  const secureUrl = (protocol, host) => protocol === "https:" || (protocol === "http:" && isLocalHost(host));
  const pageSecure = () => secureUrl(location.protocol, pageHost());
  if (!pageSecure()) return;

  // "Same site" = the top host's registrable domain per the Public Suffix List (shared.js).
  // IPs and localhost only match themselves; github.io-style tenants never match each other.
  const sameSite = NS.sameSite;

  const IS_TOP = window.top === window;
  let TOP_HOST = pageHost();
  if (!IS_TOP) {
    let ao = null;
    try { ao = location.ancestorOrigins; } catch { ao = null; }
    if (!ao || !ao.length) return;
    const hosts = [];
    for (let i = 0; i < ao.length; i++) {
      let u;
      try { u = new URL(ao[i]); } catch { return; } // opaque ("null") origins: sandboxed frames
      const h = u.hostname.toLowerCase();
      if (!h || !secureUrl(u.protocol, h)) return;
      hosts.push(h);
    }
    TOP_HOST = hosts[hosts.length - 1];
    if (!hosts.every((h) => sameSite(h, TOP_HOST)) || !sameSite(pageHost(), TOP_HOST)) return; // cross-site frame: do nothing at all
  }
  const topHost = () => (IS_TOP ? pageHost() : TOP_HOST);

  // Same wording as popup.js, plus the save-specific errors.
  const TEXT = {
    app_not_running: "Notiq isn't running. Open the app and try again.",
    no_host: "Notiq isn't set up for this browser yet. Start the Notiq app once, then restart the browser.",
    locked: "The vault is locked. Unlock it in Notiq, then try again.",
    denied: "You declined in Notiq.",
    no_match: "No saved login for this site in your vault.",
    timeout: "No answer from Notiq in time.",
    not_https: "Autofill only works on secure (https) pages.",
    no_fields: "Couldn't find a login form on this page.",
    bad_request: "Notiq couldn't read this login.",
    expired: "This save offer expired.",
    busy: "Notiq is already waiting for your approval.",
    no_reply: "Notiq didn't answer. Reload the page and try again.",
    stale: "That list of logins expired. Try again.",
    no_card: "No saved card in your vault.",
    no_card_fields: "Couldn't find card fields on this page.",
    no_code: "No 2FA code saved for this site in your vault.",
    bad_code: "The code doesn't fit these boxes.",
  };
  const GENERIC = "Something went wrong.";
  const SAVE_TEXT = { saved: "Saved to Notiq", updated: "Password updated in Notiq", unchanged: "Already saved" };
  const RETRYABLE = new Set(["locked", "timeout", "app_not_running", "no_host", "no_reply", "busy"]);

  const ICON = 18, MIN_W = 120, MIN_H = 16;
  const MAX_PW = 1024, MAX_USER = 512;
  const USER_TTL = 5 * 60 * 1000, BAR_IDLE = 25 * 1000, DEDUPE_MS = 3000;
  const LOGIN_PATH = /login|signin|sign-in|sso|auth/i;
  const USER_HINT = /user|email|login|account/i;
  const OTP_HINT = /otp|totp|2fa|mfa|verification|security.?code|one.?time/i;
  const SUBMIT_TEXT = /log ?in|sign ?in|sign ?up|continue|next|submit|register|create|save|change|update|enter|weiter|anmelden/i;
  const CURRENT_HINT = /current|old|existing/i;
  const NEW_HINT = /new.?pass|confirm|repeat|retype|re-?enter|verify|pass(word)?.?2/i;
  const MAX_CHOICES = 20;

  const settings = { offerSave: true, showIcon: true, suggestOnFocus: false, neverSave: [], hiddenSites: [], reuseTrusted: [] };
  // The in-field UI (icons, focus suggestion) is on: the setting, and this site isn't in "Hide Notiq on this site".
  // The toolbar button, Alt+Shift+L and the right-click menu keep working on a hidden site.
  const siteHidden = () => settings.hiddenSites.includes(topHost());
  const iconsOn = () => settings.showIcon && !siteHidden();
  let cachedTheme = null; // validated theme from the Notiq app (chrome.storage.local `theme`), or null
  let filled = null;   // { username, password } that Notiq just put on this page (memory only)
  let lastUser = null; // { host, value, at } last username typed here (multi-step flows)
  let lastSent = null; // { username, password, at } dedupe of capture messages

  // ---------- messaging ----------
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ error: "no_reply" });
          else resolve(res && typeof res === "object" ? res : { error: "no_reply" });
        });
      } catch {
        resolve({ error: "no_reply" }); // extension was reloaded; this script is orphaned
      }
    });
  }
  const errText = (code) => (typeof code === "string" && Object.prototype.hasOwnProperty.call(TEXT, code) ? TEXT[code] : GENERIC);

  // ---------- field helpers ----------
  const attr = (el, n) => String((el.getAttribute && el.getAttribute(n)) || "");
  const typeOf = (el) => String(el.type || "text").toLowerCase();
  const isInput = (el) => !!el && el.tagName === "INPUT";
  const isPassword = (el) => isInput(el) && typeOf(el) === "password";
  const isTextual = (el) => isInput(el) && ["text", "email", "tel"].includes(typeOf(el));
  const hintOf = (el) => `${el.name || ""} ${el.id || ""} ${attr(el, "placeholder")}`;
  const acOf = (el) => attr(el, "autocomplete").toLowerCase().split(/\s+/);
  const isOtp = (el) => acOf(el).includes("one-time-code") || OTP_HINT.test(hintOf(el));
  function isUserLike(el) {
    if (!isTextual(el) || isOtp(el)) return false;
    const ac = acOf(el);
    return ac.includes("username") || ac.includes("email") || typeOf(el) === "email" || USER_HINT.test(hintOf(el));
  }
  // The items of a tree-ordered list (inputsIn) that come before `ref`. Unlike
  // compareDocumentPosition this also orders fields in different shadow trees.
  const beforeIn = (list, ref) => { const k = list.indexOf(ref); return k < 0 ? [] : list.slice(0, k); };

  // ---------- open shadow roots ----------
  // Web-component login forms keep their inputs in OPEN shadow roots, which
  // querySelectorAll doesn't enter. Each scan lists the open roots under the
  // document (NotiqFill.shadowRoots: bounded depth and count; our own closed
  // overlay is never entered); while there are none, lookups stay plain
  // querySelectorAll. New roots are watched for mutations, and their submit and
  // scroll events (which don't leave a shadow root) are listened to as well.
  let shadowList = [];
  const hookedRoots = new WeakSet();
  const skipOwn = (h) => h === shadowHost;
  function refreshShadows() {
    shadowList = FK.shadowRoots(document, { skip: skipOwn });
    for (const sr of shadowList) {
      if (hookedRoots.has(sr)) continue;
      hookedRoots.add(sr);
      try { mo.observe(sr, MO_OPTS); } catch { /* not observable */ }
      sr.addEventListener("submit", onSubmit, true);
      sr.addEventListener("scroll", schedulePosition, { capture: true, passive: true });
    }
  }
  const deepAll = (scope, sel) => (shadowList.length
    ? FK.deepQuery(scope || document, sel, { skip: skipOwn })
    : Array.from((scope || document).querySelectorAll(sel)));
  const inputsIn = (scope) => deepAll(scope, "input");
  const activeField = () => FK.deepActive(document);

  // getComputedStyle results, kept only while one scan runs (null otherwise).
  let styleCache = null;
  function styleOf(n) {
    if (!styleCache) return getComputedStyle(n);
    let cs = styleCache.get(n);
    if (!cs) {
      const c = getComputedStyle(n);
      cs = { display: c.display, opacity: c.opacity, visibility: c.visibility };
      styleCache.set(n, cs);
    }
    return cs;
  }
  function shown(el, minW = 1, minH = 1) {
    if (!el || !el.isConnected || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < minW || r.height < minH) return false;
    let n = el;
    for (let depth = 0; n && n.nodeType === 1 && depth < 12; depth++, n = FK.parentAcross(n)) {
      const cs = styleOf(n);
      if (cs.display === "none" || parseFloat(cs.opacity) === 0) return false;
      if (depth === 0 && (cs.visibility === "hidden" || cs.visibility === "collapse")) return false;
    }
    return !(el.closest && el.closest('[aria-hidden="true"]'));
  }
  const usable = (el) => shown(el, MIN_W, MIN_H) && !el.readOnly;

  // The form, or for formless (SPA) password fields the closest ancestor that also holds another input.
  // The climb steps out of shadow roots, so a password inside its own web component finds the
  // username component next to it.
  function scopeOf(field) {
    if (field.form) return field.form;
    let n = FK.parentAcross(field);
    for (let i = 0; n && i < 6; i++, n = FK.parentAcross(n)) {
      if (inputsIn(n).some((x) => x !== field && isTextual(x))) return n;
    }
    return field.parentElement || field.getRootNode() || document; // a shadow root at the top of its tree
  }

  // Sign-up / change-password detection.
  const isCurrentPw = (i) => isPassword(i) && (acOf(i).includes("current-password") || CURRENT_HINT.test(hintOf(i)));
  // For a "new password" field: the fields a generated password goes into (the
  // new one and any confirm field in the same form) and the current-password
  // field if the form has one. null for ordinary login password fields.
  function newPasswordInfo(field) {
    if (!isPassword(field) || isCurrentPw(field)) return null;
    const pws = inputsIn(scopeOf(field)).filter((i) => isPassword(i) && usable(i));
    const isNew = acOf(field).includes("new-password") || NEW_HINT.test(hintOf(field)) || pws.length >= 2;
    if (!isNew) return null;
    const targets = pws.filter((i) => !isCurrentPw(i));
    if (!targets.includes(field)) targets.unshift(field);
    return { targets, current: pws.find(isCurrentPw) || null };
  }

  // Split one-time-code boxes: 4–8 consecutive single-character inputs, at
  // least one of which says it takes a code / digits.
  function otpBoxes() {
    const isBox = (i) => ["text", "tel", "number"].includes(typeOf(i)) && i.maxLength === 1 && shown(i) && !i.readOnly;
    const runs = [];
    let run = [];
    for (const i of inputsIn(document)) {
      if (typeOf(i) === "hidden") continue;
      if (isBox(i)) { run.push(i); continue; }
      if (run.length) runs.push(run);
      run = [];
    }
    if (run.length) runs.push(run);
    const codeLike = (i) => acOf(i).includes("one-time-code") || attr(i, "inputmode").toLowerCase() === "numeric" ||
      typeOf(i) === "number" || isOtp(i);
    return runs.find((r) => r.length >= 4 && r.length <= 8 && r.some(codeLike)) || null;
  }

  // Code-only pages (the 2FA step after the password page): a one-time-code field, or a
  // run of split code boxes, on a page that shows no password field (a login page with a
  // code field gets the code with the normal fill). Its icon asks Notiq for the matching
  // login's code only ({type:"fill", intent:"code"}), with the usual approval.
  const CODE_MIN_W = 80;
  let codeFields = new Map(); // icon field -> its split boxes (array) or null for a single field; refreshed by scan()
  const isCodeInput = (i) => (isTextual(i) || typeOf(i) === "number") && isOtp(i) && i.maxLength !== 1;
  function detectCodeFields() {
    const out = new Map();
    if (anyVisiblePassword()) return out;
    const boxes = otpBoxes();
    if (boxes) out.set(boxes[0], boxes);
    for (const i of inputsIn(document)) {
      if (out.size >= 4) break;
      if (!isCodeInput(i) || cardFields.has(i) || i.readOnly || !shown(i, CODE_MIN_W, MIN_H)) continue;
      out.set(i, null);
    }
    return out;
  }

  // ---------- detection ----------
  function detect() {
    const out = new Set();
    for (const pw of inputsIn(document)) {
      if (!isPassword(pw) || !usable(pw) || cardKindOf(pw)) continue; // a masked CVC field is not a login
      out.add(pw);
      for (const i of inputsIn(scopeOf(pw))) if (i !== pw && isUserLike(i) && usable(i)) out.add(i);
    }
    // Username-first flows: the only text field of a form on a login-looking URL.
    if (LOGIN_PATH.test(location.pathname)) {
      for (const form of shadowList.length ? deepAll(document, "form") : Array.from(document.forms || [])) {
        const ins = inputsIn(form);
        if (ins.some((i) => isPassword(i) && shown(i))) continue;
        const texts = ins.filter((i) => isTextual(i) && shown(i));
        if (texts.length === 1 && isUserLike(texts[0]) && usable(texts[0])) out.add(texts[0]);
      }
    }
    return out;
  }
  const anyVisiblePassword = () => inputsIn(document).some((i) => isPassword(i) && shown(i));

  // ---------- overlay (one closed shadow root) ----------
  // Colours come only from the --nq-* custom properties that NotiqShared.applyTheme
  // sets (one validated #rrggbb value at a time) on .nq-root; tints are color-mix().
  const CSS = `
:host { all: initial; }
.nq-root { --nq-font: system-ui, -apple-system, "Segoe UI", sans-serif;
  --nq-hover: color-mix(in srgb, var(--nq-primary) 16%, transparent);
  --nq-line: color-mix(in srgb, var(--nq-primary) 38%, var(--nq-border));
  --nq-ring: color-mix(in srgb, var(--nq-primary) 60%, transparent);
  --nq-shadow: 0 12px 32px color-mix(in srgb, #000 45%, transparent), 0 2px 6px color-mix(in srgb, #000 25%, transparent);
  --nq-primary-hover: color-mix(in srgb, var(--nq-primary) 86%, var(--nq-text));
  color: var(--nq-text); font: 13px/1.4 var(--nq-font); }
.nq-root[data-nq-mode="light"] { --nq-shadow: 0 10px 28px color-mix(in srgb, #0f172a 16%, transparent), 0 1px 3px color-mix(in srgb, #0f172a 14%, transparent); }
.nq-wrap { position: fixed; width: ${ICON}px; height: ${ICON}px; pointer-events: none; }
.nq-icon { all: initial; box-sizing: border-box; position: absolute; inset: 0; width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center; border-radius: 5px; cursor: pointer;
  pointer-events: auto; background: var(--nq-bg2); color: var(--nq-primary); opacity: .94;
  box-shadow: 0 0 0 1px var(--nq-ring), 0 1px 3px color-mix(in srgb, #000 30%, transparent); transition: opacity .15s, transform .15s; }
.nq-icon:hover { opacity: 1; transform: scale(1.08); }
.nq-icon:focus-visible { outline: 2px solid var(--nq-primary); outline-offset: 2px; }
.nq-icon svg { width: 12px; height: 12px; display: block; }
.nq-spin { display: none; width: 9px; height: 9px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--nq-primary) 30%, transparent);
  border-top-color: var(--nq-primary); animation: nq-rot .8s linear infinite; }
.nq-ok, .nq-err { display: none !important; }
.waiting .nq-key, .done .nq-key, .error .nq-key { display: none; }
.waiting .nq-spin { display: block; }
.done .nq-ok, .error .nq-err { display: block !important; }
.done .nq-icon { color: var(--nq-success); }
.error .nq-icon { color: var(--nq-danger); box-shadow: 0 0 0 1px color-mix(in srgb, var(--nq-danger) 70%, transparent), 0 1px 3px color-mix(in srgb, #000 30%, transparent); }
.nq-tip { display: none; position: absolute; top: ${ICON + 6}px; right: 0; width: max-content; max-width: 240px;
  padding: 6px 9px; border-radius: 7px; background: var(--nq-bg); color: var(--nq-text); border: 1px solid var(--nq-line);
  font: 500 12px/1.35 var(--nq-font); box-shadow: var(--nq-shadow); }
.has-tip .nq-tip { display: block; }
.nq-bar { box-sizing: border-box; position: fixed; top: 16px; right: 16px; width: 360px; max-width: calc(100vw - 32px);
  pointer-events: auto; background: var(--nq-bg); color: var(--nq-text); border: 1px solid var(--nq-line);
  border-radius: 12px; padding: 14px 14px 12px;
  box-shadow: var(--nq-shadow); font: 13px/1.4 var(--nq-font);
  animation: nq-in .22s ease-out; }
.nq-bar.out { opacity: 0; transform: translateY(-6px); transition: opacity .18s, transform .18s; }
.nq-head { display: flex; gap: 10px; align-items: center; min-width: 0; }
.nq-logo { flex: none; width: 30px; height: 30px; border-radius: 8px; background: color-mix(in srgb, var(--nq-primary) 14%, transparent); color: var(--nq-primary);
  display: flex; align-items: center; justify-content: center; }
.nq-logo svg { width: 16px; height: 16px; }
.nq-text { min-width: 0; }
.nq-title { font-weight: 650; font-size: 14px; }
.nq-sub { font-size: 12px; color: var(--nq-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nq-status { display: none; margin-top: 10px; font-size: 12.5px; align-items: center; gap: 8px; }
.nq-status.show { display: flex; }
.nq-status.err { color: var(--nq-danger); }
.nq-status.ok { color: var(--nq-success); }
.nq-status .nq-spin { display: block; flex: none; }
.nq-actions { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
.nq-btn { all: initial; box-sizing: border-box; font: 600 12.5px/1 var(--nq-font);
  padding: 8px 12px; border-radius: 8px; cursor: pointer; color: var(--nq-text); border: 1px solid color-mix(in srgb, var(--nq-text) 20%, transparent); }
.nq-btn:hover { border-color: color-mix(in srgb, var(--nq-text) 45%, transparent); }
.nq-btn:focus-visible { outline: 2px solid var(--nq-primary); outline-offset: 2px; }
.nq-primary { background: var(--nq-primary); color: var(--nq-on-primary); border-color: var(--nq-primary); }
.nq-primary:hover { background: var(--nq-primary-hover); border-color: var(--nq-primary-hover); }
.nq-quiet { margin-left: auto; border-color: transparent; color: var(--nq-muted); font-weight: 500; }
.nq-quiet:hover { color: var(--nq-text); border-color: transparent; text-decoration: underline; }
.nq-menu { box-sizing: border-box; position: fixed; width: 260px; max-width: calc(100vw - 16px); max-height: 340px;
  overflow-y: auto; pointer-events: auto; background: var(--nq-bg); color: var(--nq-text); border: 1px solid var(--nq-line);
  border-radius: 10px; padding: 5px; box-shadow: var(--nq-shadow);
  font: 13px/1.35 var(--nq-font); animation: nq-in .16s ease-out; }
.nq-mhead { padding: 6px 9px 4px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--nq-muted); }
.nq-item { all: initial; box-sizing: border-box; display: block; width: 100%; padding: 8px 9px; border-radius: 7px;
  cursor: pointer; color: var(--nq-text); text-align: left; font: 500 13px/1.3 var(--nq-font); }
.nq-item:hover, .nq-item:focus { background: var(--nq-hover); outline: none; }
.nq-item:focus-visible { box-shadow: inset 0 0 0 2px var(--nq-primary); }
.nq-ititle { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.nq-isub { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; font-size: 11.5px; color: var(--nq-muted); font-weight: 400; }
.nq-mstatus { padding: 8px 9px 4px; color: var(--nq-success); font-weight: 600; }
.nq-mnote { display: block; margin-top: 3px; font-size: 11.5px; font-weight: 400; color: var(--nq-muted); }
.nq-pw { display: block; margin: 4px 9px 6px; padding: 6px 8px; border-radius: 6px; background: var(--nq-bg2);
  font: 12.5px/1.35 ui-monospace, Consolas, monospace; word-break: break-all; user-select: all; }
.nq-mrow { display: flex; gap: 6px; padding: 4px 2px 2px; }
.nq-mrow .nq-item { flex: 1; text-align: center; }
.nq-suggest { box-sizing: border-box; position: fixed; pointer-events: auto; padding: 4px; border-radius: 10px;
  background: var(--nq-bg); color: var(--nq-text); border: 1px solid var(--nq-line); box-shadow: var(--nq-shadow);
  animation: nq-in .14s ease-out; }
.nq-sbtn { all: initial; box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px;
  border-radius: 7px; cursor: pointer; color: var(--nq-text); font: 600 13px/1.2 var(--nq-font); }
.nq-sbtn:hover, .nq-sbtn:focus { background: var(--nq-hover); outline: none; }
.nq-sbtn:focus-visible { box-shadow: inset 0 0 0 2px var(--nq-primary); }
.nq-smark { flex: none; width: 22px; height: 22px; border-radius: 6px; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--nq-primary) 16%, transparent); color: var(--nq-primary); }
.nq-smark svg { width: 12px; height: 12px; display: block; }
.nq-slabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nq-kbd { flex: none; padding: 3px 6px; border-radius: 5px; border: 1px solid var(--nq-border); background: var(--nq-bg2);
  color: var(--nq-muted); font: 500 11px/1 var(--nq-font); white-space: nowrap; }
.nq-warn { border-color: color-mix(in srgb, var(--nq-danger) 65%, var(--nq-border)); }
.nq-warn .nq-logo { background: color-mix(in srgb, var(--nq-danger) 16%, transparent); color: var(--nq-danger); }
.nq-body { margin-top: 10px; font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
.nq-body b { font-weight: 650; }
.nq-btn.nq-danger { background: var(--nq-danger); border-color: var(--nq-danger); color: var(--nq-bg); }
.nq-btn.nq-danger:hover { background: color-mix(in srgb, var(--nq-danger) 86%, var(--nq-text)); border-color: transparent; }
@keyframes nq-rot { to { transform: rotate(360deg); } }
@keyframes nq-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .nq-icon, .nq-bar, .nq-bar.out, .nq-menu, .nq-suggest { animation: none !important; transition: none !important; }
  .nq-icon:hover { transform: none; }
  .nq-spin { animation: none !important; border-color: var(--nq-primary); border-style: dotted; }
}`;

  let shadowHost = null, root = null, layer = null;
  const darkScheme = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const applyThemeNow = () => { if (layer) NS.applyTheme(layer, cachedTheme, !!(darkScheme && darkScheme.matches)); };
  if (darkScheme && typeof darkScheme.addEventListener === "function") darkScheme.addEventListener("change", applyThemeNow);
  function ensureRoot() {
    if (!shadowHost) {
      shadowHost = document.createElement("div");
      const s = shadowHost.style;
      const set = (k, v) => s.setProperty(k, v, "important");
      set("all", "initial");
      set("position", "fixed"); set("top", "0"); set("left", "0"); set("width", "0"); set("height", "0");
      set("overflow", "visible"); set("z-index", "2147483647"); set("pointer-events", "none"); set("display", "block");
      root = shadowHost.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = CSS;
      root.appendChild(style);
      // Everything we draw goes in this layer; the theme variables are set on it
      // (inside the closed root, so the page can't override them).
      layer = document.createElement("div");
      layer.className = "nq-root";
      root.appendChild(layer);
      applyThemeNow();
    }
    if (!shadowHost.isConnected) document.documentElement.appendChild(shadowHost);
  }
  // Once per page, when the user first meets our UI (never on page load): ask the
  // background to refresh the Notiq app's theme. The message carries nothing; the
  // background throttles it (one host round trip a minute) and the result arrives
  // through chrome.storage. Only the top frame may ask.
  let themeNudged = false;
  function nudgeTheme() {
    if (themeNudged || !IS_TOP) return;
    themeNudged = true;
    send({ type: "theme" });
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svg(cls, paths) {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2.4");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    if (cls) s.setAttribute("class", cls);
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, d.startsWith("C") ? "circle" : "path");
      if (d.startsWith("C")) {
        const [cx, cy, r] = d.slice(1).split(",");
        p.setAttribute("cx", cx); p.setAttribute("cy", cy); p.setAttribute("r", r);
      } else p.setAttribute("d", d);
      s.appendChild(p);
    }
    return s;
  }
  const KEY = ["C7.5,15.5,4.5", "M10.7 12.3 20 3", "M16.5 6.5l3 3", "M14 9l2 2"];
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ---------- inline icons ----------
  const iconLabel = (f) => (cardFields.has(f) ? "Fill card with Notiq" : codeFields.has(f) ? "Fill 2FA code with Notiq"
    : identityFields.has(f) ? "Fill identity with Notiq" : "Fill with Notiq");
  const icons = new Map(); // field -> { wrap, btn, tip, timer }
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => schedulePosition()) : null;
  let filling = false;

  function addIcon(field) {
    ensureRoot();
    const wrap = el("div", "nq-wrap");
    const btn = el("button", "nq-icon");
    btn.type = "button";
    btn.tabIndex = -1; // keyboard users have Alt+Shift+L; don't hijack the page's tab order
    btn.title = iconLabel(field);
    btn.setAttribute("aria-label", btn.title);
    btn.appendChild(svg("nq-key", KEY));
    btn.appendChild(el("span", "nq-spin"));
    btn.appendChild(svg("nq-ok", ["M5 12.5l4.5 4.5L19 7.5"]));
    btn.appendChild(svg("nq-err", ["M12 6v8", "M12 18v.5"]));
    const tip = el("div", "nq-tip");
    tip.setAttribute("role", "status");
    wrap.appendChild(btn);
    wrap.appendChild(tip);
    // Keep focus in the field; only a real user click may start a fill.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isTrusted !== true) return;
      onIconClick(field);
    });
    // Right-click on the icon: its menu (fill, "Hide Notiq on this site").
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isTrusted !== true) return;
      openIconMenu(field);
    });
    layer.appendChild(wrap);
    icons.set(field, { wrap, btn, tip, timer: 0 });
    if (ro) ro.observe(field);
  }
  function removeIcon(field) {
    const ic = icons.get(field);
    if (!ic) return;
    clearTimeout(ic.timer);
    ic.wrap.remove();
    icons.delete(field);
    if (ro) ro.unobserve(field);
    if (suggest && suggest.field === field) hideSuggest();
  }
  const clearIcons = () => { for (const f of Array.from(icons.keys())) removeIcon(f); };

  function setState(field, state, text) {
    const ic = icons.get(field);
    if (!ic) return;
    clearTimeout(ic.timer);
    ic.wrap.className = `nq-wrap ${state}${text ? " has-tip" : ""}`;
    ic.tip.textContent = text || "";
    const label = iconLabel(field);
    ic.btn.title = label;
    ic.btn.setAttribute("aria-label", text ? `${label}: ${text}` : label);
    if (state === "done" || state === "error") {
      ic.timer = setTimeout(() => setState(field, "idle", ""), state === "done" ? 1800 : 5000);
    }
  }

  let rafPending = false;
  function schedulePosition() {
    if (rafPending || !icons.size) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; positionAll(); });
  }
  function positionAll() {
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const [field, ic] of Array.from(icons)) {
      if (!field.isConnected) { removeIcon(field); continue; }
      const boxes = codeFields.get(field);
      const r = boxes ? unionRect(boxes) : field.getBoundingClientRect();
      const minW = boxes ? 1 : codeFields.has(field) ? CODE_MIN_W : MIN_W;
      const onScreen = r.width >= minW && r.height >= MIN_H && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      if (!onScreen) { ic.wrap.style.display = "none"; continue; }
      const size = Math.max(12, Math.min(ICON, r.height - 4));
      const pad = Math.min(8, Math.max(3, (r.height - size) / 2));
      ic.wrap.style.display = "block";
      ic.wrap.style.width = ic.wrap.style.height = `${size}px`;
      // Split boxes are too small to hold it: it goes just after the last box (inside the viewport).
      const left = boxes ? Math.min(vw - size - 2, r.right + 6) : r.right - size - pad;
      ic.wrap.style.left = `${Math.round(left)}px`;
      ic.wrap.style.top = `${Math.round(r.top + (r.height - size) / 2)}px`;
    }
    positionMenu();
    positionSuggest();
  }

  function unionRect(list) {
    const rs = list.filter((b) => b.isConnected).map((b) => b.getBoundingClientRect());
    if (!rs.length) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const left = Math.min(...rs.map((x) => x.left)), right = Math.max(...rs.map((x) => x.right));
    const top = Math.min(...rs.map((x) => x.top)), bottom = Math.max(...rs.map((x) => x.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function scan() {
    styleCache = new Map();
    try { scanNow(); } finally { styleCache = null; }
  }
  function scanNow() {
    refreshShadows();
    cardFields = detectCards();
    maybeStepFill(); // after detectCards: a masked CVC field is never a password step
    if (!iconsOn()) {
      codeFields = new Map(); identityFields = new Map();
      // A right-click menu / shortcut action still running keeps its progress icon.
      for (const f of Array.from(icons.keys())) if (!(menuIcons.has(f) && f.isConnected)) removeIcon(f);
      noteScanResult(cardFields.size > 0 || anyVisiblePassword());
      schedulePosition();
      return;
    }
    const found = detect();
    identityFields = detectIdentities(found);
    for (const f of cardIconFields(cardFields)) found.add(f);
    codeFields = detectCodeFields();
    for (const f of codeFields.keys()) found.add(f);
    for (const f of identityFields.keys()) found.add(f);
    for (const f of menuIcons) if (f.isConnected) found.add(f); // a right-click menu action still running
    for (const f of Array.from(icons.keys())) if (!found.has(f)) removeIcon(f);
    for (const f of found) if (!icons.has(f)) addIcon(f);
    noteScanResult(found.size > 0 || cardFields.size > 0);
    schedulePosition();
    // A field that got focus before it was detected (autofocus, SPA): suggest now.
    if (pendingFocus && pendingFocus === activeField() && icons.has(pendingFocus)) {
      const f = pendingFocus;
      pendingFocus = null;
      maybeSuggest(f);
    }
  }

  // ---------- "Fill with Notiq" suggestion under a focused login field ----------
  // Shows no vault data at all: one button that does exactly what the key icon
  // does (so nothing is asked of Notiq until the user clicks it, and the fill
  // still needs approval in the app). Lives in the same closed shadow root.
  let suggest = null;      // { node, btn, field }
  let pendingFocus = null; // focused input not (yet) detected as a login field
  let typedField = null;   // the field the user typed into since it got focus
  let quiet = 0;           // >0 while we move focus ourselves (fills, menus)
  const dismissedFields = new WeakSet(); // Esc: no suggestion on that field again on this page
  function focusQuietly(f, opts) {
    quiet++;
    try { f.focus(opts); } finally { quiet--; }
  }
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
  function maybeSuggest(field) {
    if (quiet || !isInput(field)) return;
    const ok = NS.shouldSuggest({
      showIcon: iconsOn(), suggestOnFocus: settings.suggestOnFocus, detected: icons.has(field) && !codeFields.has(field),
      dismissed: dismissedFields.has(field), menuOpen: !!menu, filling, typed: typedField === field,
      rect: field.getBoundingClientRect(), viewport: viewport(),
    });
    if (!ok) { if (suggest && suggest.field === field) hideSuggest(); return; }
    if (suggest && suggest.field === field) { positionSuggest(); return; }
    hideSuggest();
    ensureRoot();
    const node = el("div", "nq-suggest");
    node.setAttribute("role", "menu");
    node.setAttribute("aria-label", "Notiq");
    node.addEventListener("mousedown", (e) => e.preventDefault()); // never take focus from the field
    const btn = el("button", "nq-sbtn");
    btn.type = "button";
    btn.tabIndex = -1; // reached with ArrowDown from the field
    btn.setAttribute("role", "menuitem");
    const mark = el("span", "nq-smark");
    mark.appendChild(svg("", KEY));
    btn.appendChild(mark);
    btn.appendChild(el("span", "nq-slabel", "Fill with Notiq"));
    btn.appendChild(el("span", "nq-kbd", "Alt+Shift+L"));
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isTrusted !== true) return;
      const fromKeyboard = root.activeElement === btn;
      hideSuggest();
      if (!field.isConnected || !icons.has(field)) return;
      if (fromKeyboard) focusQuietly(field, { preventScroll: true }); // back to the field first
      onIconClick(field);
    });
    btn.addEventListener("keydown", (e) => {
      if (e.isTrusted !== true) return;
      if (e.key !== "ArrowUp" && e.key !== "Tab") return; // Enter/Space click; Esc is handled in onKeydown
      e.preventDefault();
      e.stopPropagation();
      if (field.isConnected) focusQuietly(field, { preventScroll: true });
    });
    node.appendChild(btn);
    layer.appendChild(node);
    suggest = { node, btn, field };
    positionSuggest();
    nudgeTheme();
  }
  function hideSuggest() {
    if (!suggest) return;
    const s = suggest;
    suggest = null;
    s.node.remove();
  }
  function positionSuggest() {
    if (!suggest) return;
    const { node, field } = suggest;
    if (!field.isConnected || !icons.has(field) || !iconsOn() || !settings.suggestOnFocus) { hideSuggest(); return; }
    node.style.display = "block";
    const r = field.getBoundingClientRect();
    const pos = NS.suggestPosition(r, node.offsetHeight || 40, viewport());
    if (!pos || r.width < MIN_W || r.height < MIN_H) { node.style.display = "none"; return; }
    node.style.width = `${pos.width}px`;
    node.style.left = `${pos.left}px`;
    node.style.top = `${pos.top}px`;
    if (bar && NS.rectsOverlap(node.getBoundingClientRect(), bar.node.getBoundingClientRect())) node.style.display = "none";
  }
  function dismissSuggest(refocus) {
    if (!suggest) return;
    const f = suggest.field;
    dismissedFields.add(f);
    hideSuggest();
    if (refocus && f.isConnected) focusQuietly(f, { preventScroll: true });
  }
  function onFocusIn(e) {
    const t = realTarget(e);
    // Focus in an input always gets a prompt scan, and wakes a backed-off observer
    // (a login form shown by a class/style change is found this way).
    if (isInput(t)) wakeScans(); else scheduleScan();
    schedulePosition();
    if (t === shadowHost) return; // focus moved into our own UI
    if (suggest && suggest.field !== t) hideSuggest();
    if (quiet || !isInput(t)) return;
    typedField = null;
    if (icons.has(t)) { pendingFocus = null; maybeSuggest(t); } else pendingFocus = t;
  }
  function onInput(e) {
    if (e.isTrusted !== true) return;
    const t = realTarget(e);
    if (!isInput(t)) return;
    typedField = t; // typing means the user isn't after the suggestion
    if (isPassword(t)) typedPasswords.add(t);
    if (suggest && suggest.field === t) hideSuggest();
  }

  // ---------- small menu next to an icon (generator, account chooser) ----------
  let menu = null; // { node, field, cleanup }
  const menuItems = (node) => Array.from(node.querySelectorAll(".nq-item"));
  function closeMenu(refocus) {
    if (!menu) return;
    const m = menu;
    menu = null;
    if (m.cleanup) m.cleanup();
    m.node.remove();
    if (refocus && m.field.isConnected) { try { focusQuietly(m.field, { preventScroll: true }); } catch { /* ignore */ } }
  }
  function positionMenu() {
    if (!menu) return;
    const { node, field } = menu;
    if (!field.isConnected) { closeMenu(false); return; }
    const r = field.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) { node.style.display = "none"; return; }
    node.style.display = "block";
    const w = node.offsetWidth, h = node.offsetHeight;
    const left = Math.max(8, Math.min(vw - w - 8, r.right - w));
    let top = r.bottom + 4;
    if (top + h > vh - 8 && r.top - h - 4 >= 8) top = r.top - h - 4;
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  }
  function menuItem(title, sub, fn) {
    const b = el("button", "nq-item");
    b.type = "button";
    b.tabIndex = -1;
    b.setAttribute("role", "menuitem");
    b.appendChild(el("span", "nq-ititle", title));
    if (sub) b.appendChild(el("span", "nq-isub", sub));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isTrusted !== true) return;
      fn(b);
    });
    return b;
  }
  function focusItem(node, k) {
    const items = menuItems(node);
    if (items.length) items[(k + items.length) % items.length].focus({ preventScroll: true });
  }
  // build(node) fills the menu; the first item gets keyboard focus.
  function openMenu(field, label, build) {
    closeMenu(false);
    ensureRoot();
    const node = el("div", "nq-menu");
    node.setAttribute("role", "menu");
    node.setAttribute("aria-label", label);
    node.addEventListener("mousedown", (e) => e.preventDefault());
    node.addEventListener("keydown", (e) => {
      if (e.isTrusted !== true) return;
      const items = menuItems(node);
      const at = items.indexOf(root.activeElement);
      const handled = { ArrowDown: () => focusItem(node, at + 1), ArrowUp: () => focusItem(node, at < 0 ? -1 : at - 1),
        Home: () => focusItem(node, 0), End: () => focusItem(node, -1),
        Escape: () => closeMenu(true), Tab: () => closeMenu(true) }[e.key];
      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
      handled();
    });
    hideSuggest();
    layer.appendChild(node);
    menu = { node, field, cleanup: null };
    build(node);
    positionMenu();
    focusItem(node, 0);
  }

  // ---------- strong password generator (local only) ----------
  // NotiqFill.generateFor (fillkit.js): 20 characters from upper/lower/digits/symbols
  // without look-alikes, unless the site's maxlength / minlength / passwordrules /
  // simple pattern say otherwise (then the longest allowed up to 20, never under 12
  // unless the site's maximum is lower, only allowed characters, every required class).
  // Constraints that can't be met fall back to the default and say so.
  const constraintsOf = (fields) => FK.mergeConstraints(fields.map((f) => ({
    maxLength: f.maxLength, minLength: f.minLength, rules: attr(f, "passwordrules"), pattern: attr(f, "pattern"),
  })));
  function openNewPasswordMenu(field, info) {
    openMenu(field, "Notiq password options", (node) => {
      const plan = FK.planPassword(constraintsOf(info.targets));
      const len = plan.impossible ? FK.DEFAULT_LEN : plan.length;
      const sub = plan.limited && !plan.impossible ? `${len} characters (this site's limit), filled into this form` : `${len} characters, filled into this form`;
      node.appendChild(menuItem("Generate strong password", sub, () => generateInto(field)));
      if (info.current) {
        const cur = info.current;
        node.appendChild(menuItem("Fill saved login", "Asks Notiq for approval", () => { closeMenu(false); doFill(cur, field); }));
      }
    });
  }

  // ---------- the icon's own menu (right-click on the icon): fill, "Hide Notiq on this site" ----------
  // "Hide" stores the top page's host in chrome.storage.local `hiddenSites` (the background takes it from the
  // tab's URL, never from this message); the icons and the focus suggestion then stay away from this site. The
  // toolbar button, Alt+Shift+L and the right-click menu still work here; the popup can undo it.
  function addHideItem(node) {
    if (!iconsOn()) return;
    node.appendChild(menuItem("Hide Notiq on this site", "The toolbar button and Alt+Shift+L still work",
      () => { closeMenu(true); send({ type: "hideSite" }); }));
  }
  function openIconMenu(field) {
    if (filling) return;
    hideSuggest();
    nudgeTheme();
    openMenu(field, "Notiq", (node) => {
      node.appendChild(menuItem(iconLabel(field), "Asks Notiq for approval", () => { closeMenu(false); onIconClick(field); }));
      addHideItem(node);
    });
  }
  // `only`: the fields to fill instead of the field's form (the right-click menu's "Generate password").
  function generateInto(field, only) {
    const info = only ? null : newPasswordInfo(field);
    const targets = only ? only.filter((i) => i.isConnected && shown(i) && !i.readOnly)
      : info ? info.targets.filter((i) => i.isConnected && usable(i)) : [];
    if (!targets.length || !menu) { closeMenu(true); setState(field, "error", TEXT.no_fields); return; }
    let gen = FK.generateFor(constraintsOf(targets));
    let pw = gen.password;
    for (const t of targets) setValue(t, pw);
    // What the page kept must be exactly what we generated (a script may cut it to its own limit):
    // retry once at the length it kept, else clear the fields rather than leave a password nobody knows.
    const kept = targets.map((t) => t.value);
    if (kept.some((v) => v !== pw)) {
      const short = kept.find((v) => v !== pw) || "";
      if (short.length > 0 && short.length < pw.length) {
        gen = FK.generateFor({ ...constraintsOf(targets), maxLength: short.length });
        pw = gen.password;
        for (const t of targets) setValue(t, pw);
      }
      if (targets.some((t) => t.value !== pw)) {
        for (const t of targets) setValue(t, "");
        pw = null;
        closeMenu(true);
        setState(field, "error", "This site changed the generated password. Type one yourself.");
        return;
      }
    }
    setState(field, "done", "");
    // The password stays in this closure / the fields only: nothing is sent
    // until the user submits the form and the normal save offer runs.
    const node = menu.node;
    node.textContent = "";
    const status = el("div", "nq-mstatus", targets.length > 1 ? `Strong password filled in ${targets.length} fields` : "Strong password filled");
    status.setAttribute("role", "status");
    if (gen.fallback) {
      status.appendChild(el("span", "nq-mnote", "This site's password rules couldn't be met, so Notiq's default was used. Check it is accepted."));
    } else if (gen.limited) {
      status.appendChild(el("span", "nq-mnote", `${pw.length} characters, to fit this site's rules`));
    }
    const box = el("span", "nq-pw");
    const row = el("div", "nq-mrow");
    const show = menuItem("Show", null, () => {
      const on = show.getAttribute("aria-pressed") !== "true";
      show.setAttribute("aria-pressed", on ? "true" : "false");
      show.firstChild.textContent = on ? "Hide" : "Show";
      if (on && pw) { box.textContent = pw; node.insertBefore(box, row); } else { box.textContent = ""; box.remove(); }
      positionMenu();
    });
    show.setAttribute("aria-pressed", "false");
    row.appendChild(show);
    row.appendChild(menuItem("Done", null, () => closeMenu(true)));
    node.appendChild(status);
    node.appendChild(row);
    menu.cleanup = () => { box.textContent = ""; pw = null; };
    positionMenu();
    focusItem(node, 0);
  }

  // ---------- account chooser (several logins match) ----------
  function validChoices(list) {
    if (!Array.isArray(list) || !list.length || list.length > MAX_CHOICES) return null;
    const out = [];
    for (const c of list) {
      if (!c || typeof c !== "object" || typeof c.account !== "string" || typeof c.title !== "string" || typeof c.username !== "string") return null;
      if (!c.account || c.account.length > 256 || c.title.length > 200 || c.username.length > MAX_USER) return null;
      out.push({ account: c.account, title: clean(c.title, 200), username: clean(c.username, MAX_USER) });
    }
    return out;
  }
  // pick(choice) runs the follow-up request for the chosen login.
  function openChooser(field, list, pick) {
    openMenu(field, "Choose a login", (node) => {
      node.appendChild(el("div", "nq-mhead", "Choose a login"));
      for (const c of list) {
        node.appendChild(menuItem(c.title || c.username || "Login", c.title ? c.username || "no username" : "",
          () => { closeMenu(false); pick(c); }));
      }
    });
  }

  // ---------- fill (only after a trusted click on our icon) ----------
  // Sets the value through the native setter (so React & co. notice) and fires the events a
  // typed value would: keydown / input / keyup (composed, like real ones, so listeners outside a
  // shadow root hear them too; some masked and React inputs only commit on a key event), then change.
  function setValue(input, value) {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
    focusQuietly(input);
    const key = value ? value[value.length - 1] : "";
    if (key) input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true }));
    if (d && d.set) d.set.call(input, value); else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (key) input.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function fillOtpBoxes(boxes, code) {
    boxes.forEach((b, k) => {
      const ch = code[k];
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(b), "value");
      focusQuietly(b);
      b.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
      if (d && d.set) d.set.call(b, ch); else b.value = ch;
      b.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      b.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      b.dispatchEvent(new Event("change", { bubbles: true }));
    });
    focusQuietly(boxes[boxes.length - 1]);
  }
  // cred: { username, password, code, fields?, host? }; `clicked`: the field whose icon the user clicked (if any).
  function fillFields(anchor, cred, clicked) {
    let pw = isPassword(anchor) ? anchor : inputsIn(anchor.form || scopeOf(anchor)).find((i) => isPassword(i) && usable(i)) || null;
    let n = 0;
    const used = new Set(); // the login's own fields: custom fields never go there
    if (pw) {
      const before = beforeIn(inputsIn(scopeOf(pw)), pw).filter((i) => isTextual(i) && !isOtp(i) && shown(i) && !i.readOnly);
      const user = !isPassword(anchor) ? anchor : before[before.length - 1] || null;
      if (user && cred.username) { setValue(user, cred.username); n++; used.add(user); }
      setValue(pw, cred.password); n++; used.add(pw);
    } else if (cred.username) {
      setValue(anchor, cred.username); n++; used.add(anchor);
    }
    if (cred.code) {
      const boxes = otpBoxes();
      if (boxes && boxes.length === cred.code.length && /^[0-9A-Za-z]+$/.test(cred.code)) {
        fillOtpBoxes(boxes, cred.code); n++;
        for (const b of boxes) used.add(b);
      } else {
        const otp = inputsIn(document).find((i) => isTextual(i) && isOtp(i) && i.maxLength !== 1 && shown(i) && !i.readOnly);
        if (otp) { setValue(otp, cred.code); n++; used.add(otp); }
      }
    }
    n += fillCustomFields(cred.fields, used, clicked, cred.host, (pw || anchor).form || document);
    if (n) filled = { username: cred.username || "", password: cred.password || "" };
    return n;
  }

  // ---------- custom fields (filled with the login, by name) ----------
  // `fields`: the login's custom fields [{ name, value, secret }], already validated by the background.
  // A visible, editable text field whose label / aria-label / placeholder / name / id names one of them
  // (NotiqFill.matchCustomFields: normalised whole-name match) gets its value. Never the login's own
  // username / password / 2FA fields (`used`), never one-time-code, new-password or card fields, never a
  // hidden field, and never a field that already holds something unless it is the one the user clicked.
  // Secret fields only when the login was approved for this page's own site (`host`, the same rule as
  // its password: the page and this frame are on that site). `scope`: the login's form (other forms on
  // the page are left alone), or the whole frame for formless pages.
  function fillCustomFields(fields, used, clicked, host, scope) {
    if (!Array.isArray(fields) || !fields.length) return 0;
    const ownSite = typeof host === "string" && host === topHost() && sameSite(pageHost(), host);
    const els = deepAll(scope || document, "input, textarea").filter((el) => {
      if (!FK.customFillable(el) || used.has(el) || cardFields.has(el) || el.readOnly || !shown(el)) return false;
      const ac = acOf(el);
      if (ac.includes("one-time-code") || ac.includes("new-password") || isOtp(el) || el.maxLength === 1) return false;
      return true;
    });
    const plan = FK.matchCustomFields(fields, els.map((el) => ({
      texts: FK.describeField(el), value: el.value, clicked: el === clicked, excluded: false,
    })), { allowSecret: ownSite });
    if (!plan.length) return 0;
    const back = activeField();
    for (const p of plan) setValue(els[p.field], fields[p.custom].value);
    if (back && back.isConnected && back !== activeField()) focusQuietly(back);
    return plan.length;
  }
  function onIconClick(field) {
    hideSuggest();
    nudgeTheme();
    if (menu && menu.field === field) { closeMenu(true); return; }
    closeMenu(false);
    if (filling) return;
    if (codeFields.has(field)) { doCodeFill(field); return; }
    if (cardFields.has(field)) { doCardFill(field); return; }
    if (identityFields.has(field)) { openIdentityChooser(field); return; }
    const info = newPasswordInfo(field);
    if (info) openNewPasswordMenu(field, info);
    else doFill(field, field);
  }
  // anchor: the field the credentials are filled around; field: the icon that shows progress.
  async function doFill(anchor, field, account) {
    if (filling) return;
    filling = true;
    hideSuggest();
    setState(field, "waiting", "Approve in Notiq");
    const step = usernameOnlyPage(anchor);
    const req = account ? { type: "fill", account } : { type: "fill" };
    if (step) req.step = true; // the background holds the password for the next page
    const res = await send(req);
    filling = false;
    if (res && res.choose !== undefined) {
      const list = validChoices(res.choose);
      if (!list || !field.isConnected || !anchor.isConnected || account) { setState(field, "error", GENERIC); return; }
      setState(field, "idle", "");
      openChooser(field, list, (c) => doFill(anchor, field, c.account));
      return;
    }
    if (res.ok && typeof res.password === "string" && res.host === topHost() && field.isConnected && anchor.isConnected) {
      const n = fillFields(anchor, {
        username: typeof res.username === "string" ? res.username : "",
        password: res.password,
        code: typeof res.code === "string" ? res.code : "",
        fields: NS.validCustomFields(res.fields), host: res.host,
      }, field);
      if (step && !n) send({ type: "stepCancel" });
      setState(field, n ? "done" : "error", n ? "Filled" : TEXT.no_fields);
    } else {
      if (step && res.ok) send({ type: "stepCancel" });
      setState(field, "error", res.ok ? GENERIC : errText(res.error));
    }
  }

  // ---------- one-time code only (separate 2FA page; trusted click on a code field's icon) ----------
  // The background asks Notiq with intent "code": only logins with a 2FA secret count, the
  // usual approval / 5-minute trust applies, and the reply carries the code, never a password.
  async function doCodeFill(field, account) {
    if (filling) return;
    filling = true;
    hideSuggest();
    setState(field, "waiting", "Approve in Notiq");
    const res = await send(account ? { type: "fill", intent: "code", account } : { type: "fill", intent: "code" });
    filling = false;
    if (res && res.choose !== undefined) {
      const list = validChoices(res.choose);
      if (!list || !field.isConnected || account) { setState(field, "error", GENERIC); return; }
      setState(field, "idle", "");
      openChooser(field, list, (c) => doCodeFill(field, c.account));
      return;
    }
    if (res.ok && typeof res.code === "string" && res.host === topHost() && field.isConnected) {
      const n = fillCode(field, res.code);
      setState(field, n ? "done" : "error", n ? "Code filled" : TEXT.bad_code);
    } else {
      setState(field, "error", res.ok ? GENERIC : errText(res.error));
    }
  }
  // Split boxes get one character each (the code must have exactly as many characters).
  function fillCode(field, code) {
    if (!/^[0-9A-Za-z]{4,10}$/.test(code)) return 0;
    const boxes = codeFields.get(field);
    if (boxes) {
      if (boxes.length !== code.length || !boxes.every((b) => b.isConnected)) return 0;
      fillOtpBoxes(boxes, code);
      return 1;
    }
    if (field.maxLength > 0 && field.maxLength < code.length) return 0;
    setValue(field, code);
    return 1;
  }

  // ---------- payment cards (only after a trusted click on a card field's icon) ----------
  // Card fields are found by their autocomplete tokens (cc-number, cc-exp, cc-exp-month, cc-exp-year,
  // cc-name, cc-csc) or by name / id / placeholder / label hints (NotiqShared.cardFieldKind). A field
  // found by hints alone counts only when this frame also shows a card number field. The icon sits in
  // the card number field (or, in a frame without one, the first tagged card field). Cross-site payment
  // iframes (Stripe and the like) never get here: the frame check at the top quits first, and the
  // background re-checks the sender. The card is kept in local variables for the fill only.
  let cardFields = new Map(); // field -> kind, refreshed by scan()

  function labelOf(f) {
    let t = attr(f, "aria-label");
    try { for (const l of Array.from(f.labels || [])) t += ` ${l.textContent || ""}`; } catch { /* no labels */ }
    return t.slice(0, 200);
  }
  function cardKindOf(f) {
    if (!f || (f.tagName !== "INPUT" && f.tagName !== "SELECT")) return null;
    return NS.cardFieldKind({
      tag: f.tagName, type: f.tagName === "SELECT" ? "select" : typeOf(f), autocomplete: attr(f, "autocomplete"),
      name: f.name, id: f.id, placeholder: attr(f, "placeholder"), label: labelOf(f),
    });
  }
  function detectCards() {
    const found = [];
    for (const f of deepAll(document, "input, select")) {
      if (f.tagName === "INPUT" && (typeOf(f) === "hidden" || f.readOnly)) continue;
      const r = cardKindOf(f);
      if (r && shown(f)) found.push([f, r]);
    }
    const hasNumber = found.some(([, r]) => r.kind === "number");
    const out = new Map();
    for (const [f, r] of found) if (r.tagged || hasNumber) out.set(f, r.kind);
    return out;
  }
  function cardIconFields(cards) {
    const inputs = Array.from(cards.keys()).filter((f) => f.tagName === "INPUT" && usable(f));
    const numbers = inputs.filter((f) => cards.get(f) === "number");
    return numbers.length ? numbers : inputs.slice(0, 1);
  }
  // Fills the anchor's form when it holds other card fields, else every card field of this frame
  // (formless checkouts). The first field of each kind wins. Returns how many fields were set.
  function fillCardFields(anchor, card) {
    const all = detectCards();
    const inForm = anchor.form ? Array.from(all.keys()).filter((f) => f.form === anchor.form) : [];
    const scope = inForm.length > 1 ? inForm : Array.from(all.keys());
    const done = new Set();
    let n = 0;
    for (const f of scope) {
      const kind = all.get(f);
      if (done.has(kind)) continue;
      const v = NS.cardFieldValue(kind, card, {
        tag: f.tagName, maxLength: f.maxLength, placeholder: attr(f, "placeholder"),
        options: f.tagName === "SELECT" ? Array.from(f.options).map((o) => ({ value: o.value, text: o.text })) : null,
      });
      if (v === null) continue;
      setValue(f, v);
      done.add(kind);
      n++;
    }
    if (n && anchor.isConnected) focusQuietly(anchor, { preventScroll: true });
    return n;
  }
  async function doCardFill(field) {
    if (filling) return;
    filling = true;
    hideSuggest();
    setState(field, "waiting", "Approve in Notiq");
    const res = await send({ type: "fillCard" });
    filling = false;
    const card = res && res.ok && res.host === topHost() && res.card && typeof res.card.number === "string" ? res.card : null;
    if (card && field.isConnected) {
      const n = fillCardFields(field, card);
      setState(field, n ? "done" : "error", n ? "Card filled" : TEXT.no_card_fields);
    } else {
      setState(field, "error", res.ok ? GENERIC : errText(res.error));
    }
  }

  // ---------- identities: address / contact forms (only after a trusted click or a menu choice) ----------
  // Fields are classified by NotiqIdentity.identityFieldKind (identity.js): autocomplete tokens first (name,
  // given-name / family-name, email, tel, address-line1/2, street-address, address-level1/2, postal-code,
  // country / country-name), then label / name / id / placeholder hints (incl. "PIN code", "Mobile",
  // "Flat, House no."). A form gets icons only when it looks like an address or contact form
  // (NotiqIdentity.isIdentityForm), has no visible password field, and the field isn't a login or card field.
  // Clicking the icon lists the identity titles (no values) when Notiq is unlocked, else goes straight to Notiq,
  // which always asks the user to pick an identity and shows the site. Hidden, read-only and disabled fields
  // are never filled; the identity is kept in local variables for the fill only.
  const NI = globalThis.NotiqIdentity; // identity.js, loaded before this file
  const IDENTITY_TEXT = {
    no_identity: "No saved identity in your vault. Add one in Notiq (New > Identity).",
    no_identity_fields: "Couldn't find address or contact fields here.",
    unknown_op: "Update Notiq to use this.",
  };
  const identityErr = (code) =>
    (typeof code === "string" && Object.prototype.hasOwnProperty.call(IDENTITY_TEXT, code) ? IDENTITY_TEXT[code] : errText(code));
  const MAX_IDENTITY_ICONS = 12; // per form
  let identityFields = new Map(); // icon field -> kind, refreshed by scan()

  function identityKindOf(f) {
    if (!NI || !f || (f.tagName !== "INPUT" && f.tagName !== "SELECT" && f.tagName !== "TEXTAREA")) return null;
    return NI.identityFieldKind({
      tag: f.tagName, type: f.tagName === "INPUT" ? typeOf(f) : "", autocomplete: attr(f, "autocomplete"),
      name: f.name, id: f.id, placeholder: attr(f, "placeholder"), label: labelOf(f),
    });
  }
  // The visible, editable identity fields in `scope`, in page order: [[field, { kind, tagged }]].
  function identityFieldsIn(scope) {
    const out = [];
    for (const f of deepAll(scope || document, "input, select, textarea")) {
      if ((f.tagName === "INPUT" && typeOf(f) === "hidden") || f.readOnly || f.disabled || cardFields.has(f)) continue;
      const r = identityKindOf(f);
      if (r && shown(f)) out.push([f, r]);
    }
    return out;
  }
  // Icon fields of the page's address / contact forms. `loginFields`: the login fields detect() found.
  function detectIdentities(loginFields) {
    if (!NI) return new Map();
    const groups = new Map();
    for (const [f, r] of identityFieldsIn(document)) {
      if (loginFields.has(f)) continue;
      const key = f.form || document;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([f, r]);
    }
    const out = new Map();
    for (const [key, list] of groups) {
      if (!NI.isIdentityForm(list.map(([, r]) => r))) continue;
      if (inputsIn(key).some((i) => isPassword(i) && shown(i))) continue; // a sign-up / login form
      let n = 0;
      for (const [f, r] of list) {
        if (n >= MAX_IDENTITY_ICONS) break;
        if (f.tagName !== "SELECT" && usable(f)) { out.set(f, r.kind); n++; }
      }
    }
    return out;
  }

  // Where an identity goes: the anchor's form; for formless pages the closest ancestor with two or more
  // identity fields, else the page.
  function identityScope(anchor) {
    if (anchor.form) return anchor.form;
    let n = FK.parentAcross(anchor);
    for (let i = 0; n && i < 8; i++, n = FK.parentAcross(n)) {
      if (n.nodeType === 1 && identityFieldsIn(n).length >= 2) return n;
    }
    return document;
  }
  const identityValue = (f, kind, id) => NI.identityFieldValue(kind, id, {
    tag: f.tagName, type: f.tagName === "INPUT" ? typeOf(f) : "", maxLength: f.maxLength, autocomplete: attr(f, "autocomplete"),
    options: f.tagName === "SELECT" ? Array.from(f.options).map((o) => ({ value: o.value, text: o.text })) : null,
  });
  const SECTION_TOKEN = /^(section-.+|shipping|billing)$/;
  // Fills one form's identity fields (the first field of each kind; the country first, since forms often reload
  // their state list when it changes). Returns how many fields were set.
  function fillIdentityFields(anchor, id) {
    let list = identityFieldsIn(identityScope(anchor));
    // Shipping and billing addresses in one form: stay in the section the anchor names, if any.
    const section = acOf(anchor).filter((t) => SECTION_TOKEN.test(t));
    if (section.length) {
      const same = list.filter(([f]) => section.every((t) => acOf(f).includes(t)));
      if (same.length) list = same;
    }
    const kinds = NI.resolveKinds(list.map(([, r]) => r.kind));
    const rank = (i) => (kinds[i] === "country" ? 0 : 1);
    const order = list.map((_, i) => i).sort((a, b) => rank(a) - rank(b));
    const done = new Set();
    const stateLater = [];
    let n = 0;
    for (const i of order) {
      const f = list[i][0], kind = kinds[i];
      if (done.has(kind)) continue;
      const v = identityValue(f, kind, id);
      if (v === null) { if (kind === "state" && f.tagName === "SELECT") stateLater.push(f); continue; }
      setValue(f, v);
      done.add(kind);
      n++;
    }
    if (stateLater.length && !done.has("state")) {
      setTimeout(() => {
        for (const f of stateLater) {
          if (done.has("state") || !f.isConnected || !shown(f)) continue;
          const v = identityValue(f, "state", id);
          if (v !== null) { setValue(f, v); done.add("state"); }
        }
      }, 400);
    }
    if (n && anchor.isConnected) focusQuietly(anchor, { preventScroll: true });
    return n;
  }

  async function doIdentityFill(field, account) {
    if (filling || !NI) return;
    filling = true;
    hideSuggest();
    setState(field, "waiting", "Approve in Notiq");
    const res = await send(account ? { type: "fillIdentity", account } : { type: "fillIdentity" });
    filling = false;
    const id = res && res.ok && res.host === topHost() && res.identity && typeof res.identity === "object"
      ? NI.validIdentityReply({ ...res.identity, ok: true }) : null;
    if (id && field.isConnected) {
      const n = fillIdentityFields(field, id);
      setState(field, n ? "done" : "error", n ? "Filled" : IDENTITY_TEXT.no_identity_fields);
    } else {
      setState(field, "error", res && res.ok ? GENERIC : identityErr(res && res.error));
    }
  }

  // The in-page chooser: the identity titles when Notiq is unlocked; otherwise (locked, closed, an older
  // Notiq, no identities) Notiq itself asks, unlocking first if needed.
  let identityListing = false;
  async function openIdentityChooser(field) {
    if (filling || identityListing || !NI) return;
    identityListing = true;
    const res = await send({ type: "identities" });
    identityListing = false;
    if (!field.isConnected || filling) return;
    const list = res && res.ok ? NI.validIdentityList(res) : null;
    if (!list || !list.length) { await doIdentityFill(field); return; }
    openMenu(field, "Choose an identity", (node) => {
      node.appendChild(el("div", "nq-mhead", "Fill identity"));
      for (const c of list) {
        node.appendChild(menuItem(c.title, "Asks Notiq for approval", () => { closeMenu(false); doIdentityFill(field, c.account); }));
      }
      node.appendChild(menuItem("Choose in Notiq…", null, () => { closeMenu(false); doIdentityFill(field); }));
    });
  }

  // ---------- right-click menu: Notiq > Fill login · Fill 2FA code · Fill identity · Generate password ----------
  // The background sends the choice to the frame the menu was opened in (only frames that pass the same-site
  // check run this script). It acts on the editable field the page's context menu was opened on (a trusted
  // event, at most 2 minutes ago), else the focused one, with the same paths as the icons.
  const MENU_TTL = 2 * 60 * 1000;
  const MENU_INPUT_TYPES = ["", "text", "email", "tel", "password", "number", "search", "url"];
  let menuTarget = null; // { field, at }
  const menuIcons = new Set(); // fields that got a temporary icon to show a menu action's progress
  const editableField = (t) => !!t && !t.readOnly && !t.disabled &&
    ((t.tagName === "INPUT" && MENU_INPUT_TYPES.includes(typeOf(t))) || t.tagName === "TEXTAREA");

  function onContextMenu(e) {
    if (e.isTrusted !== true) return;
    const t = realTarget(e);
    if (!editableField(t)) { menuTarget = null; return; }
    menuTarget = { field: t, at: Date.now() };
    send({ type: "menuOpening" }); // lets the background load the identity titles for the menu
  }
  function menuField() {
    const m = menuTarget, now = Date.now();
    if (m && m.field.isConnected && now - m.at < MENU_TTL && now >= m.at && editableField(m.field)) return m.field;
    const a = activeField();
    return editableField(a) ? a : null;
  }
  // The menu works on any editable field; one without an icon gets one while the request runs.
  function withIcon(field) {
    if (icons.has(field)) return;
    menuIcons.add(field);
    addIcon(field);
    schedulePosition();
  }
  function menuDone(field) {
    if (!menuIcons.has(field)) return;
    setTimeout(() => { menuIcons.delete(field); wakeScans(); }, 5500); // the next scan drops the icon
  }
  function onMenuFill(msg) {
    const field = menuField();
    if (!field || filling) return;
    hideSuggest();
    nudgeTheme();
    closeMenu(false);
    const input = field.tagName === "INPUT";
    const run = (p) => Promise.resolve(p).catch(() => {}).finally(() => menuDone(field));
    switch (msg.action) {
      case "login":
        if (!input) return;
        withIcon(field);
        run(doFill(field, field));
        return;
      case "code": {
        if (!input) return;
        const boxes = otpBoxes();
        const target = boxes && boxes.includes(field) && codeFields.has(boxes[0]) ? boxes[0] : field;
        withIcon(target);
        Promise.resolve(doCodeFill(target)).catch(() => {}).finally(() => menuDone(target));
        return;
      }
      case "identity":
        withIcon(field);
        run(doIdentityFill(field, typeof msg.account === "string" && msg.account ? msg.account : undefined));
        return;
      case "chooseIdentity":
        withIcon(field);
        run(openIdentityChooser(field));
        return;
      case "generate": {
        if (!input) return;
        const info = newPasswordInfo(field);
        openMenu(field, "Notiq password options", () => {});
        generateInto(field, info ? info.targets : [field]);
        return;
      }
    }
  }
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!sender || sender.id !== chrome.runtime.id || sender.tab) return false;
    if (msg && msg.type === "menuFill" && typeof msg.action === "string") onMenuFill(msg);
    return false;
  });
  document.addEventListener("contextmenu", onContextMenu, true);

  // ---------- multi-step logins (username page, then password page) ----------
  // On a username-only page the approved fill puts in just the username and the
  // background keeps the password (memory only, this tab + site, 2 minutes, once).
  // When an empty login password field then shows up (SPA step or the next page on
  // the same site) we ask for it once and fill it. Never submits anything.
  function usernameOnlyPage(anchor) {
    if (isPassword(anchor) || !isTextual(anchor) || isOtp(anchor) || anyVisiblePassword()) return false;
    return !inputsIn(anchor.form || scopeOf(anchor)).some((i) => isPassword(i) && usable(i));
  }
  const stepAsked = new WeakSet(); // password fields we already asked about
  let stepBusy = false;
  function maybeStepFill() {
    if (stepBusy || filling) return;
    const pw = inputsIn(document).find((i) => isPassword(i) && !cardFields.has(i) && !stepAsked.has(i) && !i.value && usable(i) && !newPasswordInfo(i));
    if (!pw) return;
    stepAsked.add(pw);
    stepBusy = true;
    send({ type: "stepFill" }).then((res) => {
      stepBusy = false;
      if (!res || !res.ok || typeof res.password !== "string" || !res.password || res.host !== topHost()) return;
      if (!pw.isConnected || !usable(pw) || pw.value) return;
      const username = typeof res.username === "string" ? res.username : "";
      // A username field on this step that holds a different account: not ours to fill.
      const before = beforeIn(inputsIn(scopeOf(pw)), pw).filter((i) => isTextual(i) && !isOtp(i) && shown(i) && !i.readOnly);
      const user = before[before.length - 1] || null;
      if (user && user.value && user.value.trim().toLowerCase() !== username.trim().toLowerCase()) return;
      const n = fillFields(pw, {
        username: user && !user.value ? username : "", password: res.password, code: "",
        fields: NS.validCustomFields(res.fields), host: res.host,
      });
      if (n) {
        filled = { username, password: res.password };
        if (icons.has(pw)) setState(pw, "done", "Filled");
      }
    });
  }

  // ---------- capture of submitted logins ----------
  const clean = (s, max) => String(s || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const cleanUrl = () => clean(location.origin + location.pathname, 2048);

  function rememberUser(value) {
    const v = clean(value, MAX_USER);
    if (v) lastUser = { host: pageHost(), value: v, at: Date.now() };
  }
  function recentUser() {
    return lastUser && lastUser.host === pageHost() && Date.now() - lastUser.at < USER_TTL ? lastUser.value : "";
  }
  function pickPassword(pws) {
    const fresh = pws.filter((i) => acOf(i).includes("new-password"));
    if (fresh.length) return fresh[0];
    if (pws.length >= 3) return pws[1];                     // current, new, confirm
    if (pws.length === 2) return pws[0].value === pws[1].value ? pws[0] : pws[1]; // new+confirm / current+new
    return pws[0];
  }

  // Returns the payload it sent (for tests) or null when skipped.
  function capture(scope) {
    if (!settings.offerSave || !pageSecure()) return null;
    const host = pageHost();
    if (!host || settings.neverSave.includes(topHost())) return null;
    const ins = inputsIn(scope);
    const pws = ins.filter((i) => isPassword(i) && i.value && shown(i) && !cardKindOf(i)); // never offer a CVC as a login
    if (!pws.length) {
      const u = ins.find((i) => isUserLike(i) && i.value && shown(i));
      if (u) rememberUser(u.value);
      return null;
    }
    const pw = pickPassword(pws);
    const password = String(pw.value);
    if (!password || password.length > MAX_PW) return null;
    const before = beforeIn(ins, pws[0]).filter((i) => isTextual(i) && !isOtp(i) && i.value && shown(i));
    const hiddenUser = ins.find((i) => isInput(i) && acOf(i).includes("username") && i.value && !isPassword(i));
    // Change-password form (current + new [+ confirm]): the saved password is the new one, and the current one
    // (only sent to Notiq, to find the login to update) comes from the current-password field.
    const currentField = pws.find((i) => i !== pw && isCurrentPw(i)) ||
      (pws.length >= 3 && pws[0] !== pw ? pws[0] : null) ||
      (pws.length === 2 && pws[0] !== pw && pws[0].value !== pw.value ? pws[0] : null);
    const change = (!!currentField || ins.some((i) => isCurrentPw(i) && shown(i))) && !isCurrentPw(pw);
    const current = change && currentField && currentField.value && currentField.value !== password && currentField.value.length <= MAX_PW ? String(currentField.value) : "";
    // Such pages rarely show the username: the one remembered from the sign-in, or the one Notiq filled here.
    const signedIn = recentUser() || (change && filled && filled.username) || "";
    const username = clean((before.length && before[before.length - 1].value) || (hiddenUser && hiddenUser.value) || signedIn, MAX_USER);
    if (filled && password === filled.password && (!username || username === filled.username)) return null;
    const now = Date.now();
    if (lastSent && lastSent.password === password && lastSent.username === username && now - lastSent.at < DEDUPE_MS) return null;
    lastSent = { username, password, at: now };
    if (username) rememberUser(username);
    const payload = { host, url: cleanUrl(), username, password, title: clean(document.title, 80), change, ...(current ? { current } : {}) };
    send({ type: "capture", payload });
    // SPAs often don't navigate after login; look again once the form is gone.
    // (Frames: the background asks the top frame to look.)
    if (IS_TOP) {
      schedulePending(1500);
      setTimeout(() => schedulePending(0), 4500);
    }
    return payload;
  }

  const realTarget = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
  function onSubmit(e) {
    if (e.isTrusted !== true) return;
    const form = e.target;
    if (form && form.tagName === "FORM") { capture(form); reuseCheckScope(form); }
  }
  function onKeydown(e) {
    if (e.isTrusted !== true) return;
    if (suggest) {
      const t = realTarget(e);
      const inField = t === suggest.field, inSuggest = t === shadowHost && root.activeElement === suggest.btn;
      if (e.key === "Escape" && (inField || inSuggest)) {
        e.preventDefault();
        e.stopPropagation();
        dismissSuggest(inSuggest);
        return;
      }
      if (e.key === "ArrowDown" && inField && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
        suggest.node.style.display !== "none") {
        e.preventDefault();
        e.stopPropagation();
        suggest.btn.focus({ preventScroll: true });
        return;
      }
    }
    if (e.key === "Escape" && menu) { closeMenu(true); return; }
    if (e.key === "Escape" && bar) { closeBar(true); return; }
    if (e.key === "Escape" && warn && realTarget(e) === shadowHost) { closeWarn(); return; }
    if (e.key !== "Enter") return;
    const t = realTarget(e);
    if (isPassword(t)) { capture(scopeOf(t)); reuseCheck(t); }
    else if (isUserLike(t) && t.value) rememberUser(t.value);
  }
  function nearbyPassword(node) {
    let n = node.parentElement;
    for (let i = 0; n && i < 5; i++, n = n.parentElement) {
      const pw = inputsIn(n).find((x) => isPassword(x) && x.value && shown(x));
      if (pw) return pw;
    }
    return null;
  }
  function onClick(e) {
    if (e.isTrusted !== true) return;
    const t = realTarget(e);
    if (menu && t !== shadowHost) closeMenu(false); // click outside our UI closes the menu
    if (suggest && t !== shadowHost && t !== suggest.field) hideSuggest();
    if (!t || !t.closest || t === shadowHost) return;
    const b = t.closest('button, input[type="submit"], input[type="image"], input[type="button"], [role="button"]');
    if (!b) return;
    const form = b.form || b.closest("form");
    const submitLike = (b.tagName === "BUTTON" && typeOf(b) === "submit") ||
      (isInput(b) && ["submit", "image"].includes(typeOf(b))) ||
      SUBMIT_TEXT.test(`${b.textContent || ""} ${b.value || ""} ${attr(b, "aria-label")}`);
    if (form) { if (submitLike) capture(form); return; }
    const pw = nearbyPassword(b);
    if (pw) capture(scopeOf(pw));
    else if (submitLike) {
      const u = inputsIn(document).find((i) => isUserLike(i) && i.value && shown(i));
      if (u) rememberUser(u.value);
    }
  }
  function onChange(e) {
    if (e.isTrusted !== true) return;
    const t = realTarget(e);
    if (isUserLike(t) && t.value) rememberUser(t.value);
  }

  // ---------- save bar ----------
  let bar = null, barIdle = 0, pendingTimer = 0;
  function schedulePending(delay) {
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(checkPending, delay);
  }
  async function checkPending() {
    if (!IS_TOP || bar || warn || !settings.offerSave || anyVisiblePassword()) return;
    const res = await send({ type: "pending" });
    const p = res && res.pending;
    if (!p || typeof p.host !== "string" || typeof p.username !== "string") return;
    if (bar || warn || !settings.offerSave || settings.neverSave.includes(p.host.toLowerCase()) || anyVisiblePassword()) return;
    // `kind` is Notiq's own answer (an exact copy already saved never gets here); older backgrounds send `change`.
    const update = NS.offerKind(p.kind, p.change) === "update";
    showBar({ host: clean(p.host, 253).toLowerCase(), username: clean(p.username, MAX_USER), change: update });
  }

  function armIdle() {
    clearTimeout(barIdle);
    barIdle = setTimeout(() => closeBar(true), BAR_IDLE);
  }
  function closeBar(dismiss) {
    if (!bar) return;
    clearTimeout(barIdle);
    const b = bar.node;
    bar = null;
    if (dismiss) send({ type: "dismiss" });
    b.classList.add("out");
    setTimeout(() => b.remove(), 200);
  }
  function showBar(p) {
    ensureRoot();
    const node = el("div", "nq-bar");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-live", "polite");
    node.setAttribute("aria-label", p.change ? "Update password in Notiq" : "Save login to Notiq");
    const head = el("div", "nq-head");
    const logo = el("div", "nq-logo");
    logo.appendChild(svg("", KEY));
    const text = el("div", "nq-text");
    text.appendChild(el("div", "nq-title", p.change ? "Update password in Notiq?" : "Save login to Notiq?"));
    text.appendChild(el("div", "nq-sub", `${p.host} · ${p.username || "no username"}`));
    head.appendChild(logo);
    head.appendChild(text);
    const status = el("div", "nq-status");
    const statusText = el("span", "");
    const actions = el("div", "nq-actions");
    const mk = (label, cls, fn) => {
      const b = el("button", `nq-btn ${cls}`, label);
      b.type = "button";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.isTrusted !== true) return;
        fn();
      });
      return b;
    };
    const setStatus = (kind, msg, spin) => {
      status.textContent = "";
      if (spin) status.appendChild(el("span", "nq-spin"));
      statusText.textContent = msg;
      status.appendChild(statusText);
      status.className = `nq-status show ${kind}`;
    };
    const setActions = (...btns) => { actions.textContent = ""; for (const b of btns) actions.appendChild(b); };
    let saving = false;
    const doSave = async () => {
      if (saving) return;
      saving = true;
      clearTimeout(barIdle);
      setActions();
      setStatus("", "Waiting for approval in Notiq…", true);
      const res = await send({ type: "save" });
      saving = false;
      if (!bar || bar.node !== node) return;
      if (res.ok) {
        setStatus("ok", SAVE_TEXT[res.status] || SAVE_TEXT.saved, false);
        setTimeout(() => { if (bar && bar.node === node) closeBar(false); }, 2500);
        return;
      }
      setStatus("err", errText(res.error), false);
      const close = mk("Close", "", () => closeBar(true));
      if (RETRYABLE.has(res.error)) setActions(mk("Try again", "nq-primary", doSave), close);
      else setActions(close);
      armIdle();
    };
    setActions(
      mk(p.change ? "Update" : "Save", "nq-primary", doSave),
      mk("Not now", "", () => closeBar(true)),
      mk("Never for this site", "nq-quiet", () => { send({ type: "never" }); closeBar(false); }),
    );
    node.appendChild(head);
    node.appendChild(status);
    node.appendChild(actions);
    for (const ev of ["pointermove", "focusin", "keydown"]) node.addEventListener(ev, () => { if (!saving) armIdle(); });
    layer.appendChild(node);
    bar = { node };
    positionSuggest(); // never sits under the card
    nudgeTheme();
    armIdle();
  }

  // Alt+Shift+L on a site where Notiq is hidden: the focused login (or 2FA code) field, else the first one,
  // gets a temporary icon for the request's progress, as for a right-click menu action.
  function shortcutOnHiddenSite() {
    if (filling) return;
    const logins = Array.from(detect());
    const codes = Array.from(detectCodeFields().keys());
    const active = activeField();
    const field = logins.includes(active) || codes.includes(active) ? active
      : logins.find((f) => f.isConnected && shown(f)) || codes.find((f) => f.isConnected && shown(f));
    if (!field || !(active === field || document.hasFocus())) return;
    hideSuggest();
    nudgeTheme();
    closeMenu(false);
    withIcon(field);
    const info = codes.includes(field) ? null : newPasswordInfo(field);
    const run = codes.includes(field) ? doCodeFill(field) : info ? openNewPasswordMenu(field, info) : doFill(field, field);
    Promise.resolve(run).catch(() => {}).finally(() => menuDone(field));
  }

  // ---------- password-reuse / phishing warning ----------
  // When the user leaves a password field they typed into (blur), or submits its form, and the password has
  // 8+ characters: the background hands out this app run's salt, the tag HMAC-SHA256(salt, password) cut to 16
  // bytes is computed HERE (NotiqFill.reuseTag, WebCrypto), and only the tag goes to the background and Notiq.
  // The password never leaves this content script. Notiq compares it with the unlocked vault's logins and
  // answers with only the site of a login saved for ANOTHER site, or nothing (locked vault, no match, same
  // site, "other sites" of that login). Each tag is checked once per page; nothing is asked on page load, for
  // a password Notiq itself just filled here, or on a site the user trusted from this card.
  const typedPasswords = new WeakSet(); // password fields that got trusted input
  const reuseSeen = new Set();          // salt:tag already checked on this page
  let reuseBusy = false, warn = null;
  function reuseCandidate(field) {
    if (!isPassword(field) || !typedPasswords.has(field) || !field.isConnected || cardKindOf(field)) return null;
    const pw = String(field.value || "");
    if (!FK.reuseEligible(pw) || (filled && pw === filled.password)) return null;
    if (settings.reuseTrusted.includes(topHost())) return null;
    return pw;
  }
  async function reuseCheck(field) {
    if (reuseBusy || reuseCandidate(field) === null) return;
    reuseBusy = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const s = await send({ type: "reuseSalt" });
        if (!s || s.ok !== true || typeof s.salt !== "string") return;
        const pw = reuseCandidate(field); // read again: the value may have changed while we waited
        if (pw === null) return;
        let tag = null;
        try { tag = await FK.reuseTag(globalThis.crypto && globalThis.crypto.subtle, s.salt, pw); } catch { tag = null; }
        if (!tag) return;
        const key = `${s.salt}:${tag}`;
        if (reuseSeen.has(key)) return;
        const r = await send({ type: "reuseCheck", salt: s.salt, tag });
        if (r && r.error === "stale_salt") continue; // Notiq restarted meanwhile: once more with the new salt
        if (r && r.ok === true) reuseSeen.add(key);
        if (r && r.ok === true && typeof r.site === "string" && r.site && !sameSite(topHost(), r.site) &&
          !settings.reuseTrusted.includes(topHost())) showWarn(clean(r.site, 253).toLowerCase());
        return;
      }
    } finally {
      reuseBusy = false;
    }
  }
  function reuseCheckScope(scope) {
    for (const i of inputsIn(scope)) if (isPassword(i) && typedPasswords.has(i) && i.value) { reuseCheck(i); return; }
  }

  function closeWarn() {
    if (!warn) return;
    const w = warn.node;
    warn = null;
    w.classList.add("out");
    setTimeout(() => w.remove(), 200);
  }
  function showWarn(site) {
    if (warn) return;
    ensureRoot();
    if (bar) closeBar(false); // no save offer next to a "check the address" warning
    const host = topHost();
    const node = el("div", "nq-bar nq-warn");
    node.setAttribute("role", "alertdialog");
    node.setAttribute("aria-live", "assertive");
    node.setAttribute("aria-label", "Notiq: password for another site");
    const head = el("div", "nq-head");
    const logo = el("div", "nq-logo");
    logo.appendChild(svg("", ["M12 3l9.5 17h-19z", "M12 10v4", "M12 17v.5"]));
    const text = el("div", "nq-text");
    text.appendChild(el("div", "nq-title", "Password for another site"));
    head.appendChild(logo);
    head.appendChild(text);
    const body = el("div", "nq-body");
    body.appendChild(document.createTextNode("This is your password for "));
    body.appendChild(el("b", "", site));
    body.appendChild(document.createTextNode(". This site is "));
    body.appendChild(el("b", "", host));
    body.appendChild(document.createTextNode(". Check the address before you continue."));
    const actions = el("div", "nq-actions");
    const mk = (label, cls, fn) => {
      const b = el("button", `nq-btn ${cls}`, label);
      b.type = "button";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.isTrusted !== true) return;
        fn();
      });
      return b;
    };
    actions.appendChild(mk("Leave this site", "nq-danger", () => { send({ type: "reuseLeave" }); closeWarn(); }));
    actions.appendChild(mk("It's OK, I trust this site", "nq-quiet", () => { send({ type: "reuseTrust" }); closeWarn(); }));
    node.appendChild(head);
    node.appendChild(body);
    node.appendChild(actions);
    layer.appendChild(node);
    warn = { node };
    hideSuggest();
    nudgeTheme();
  }
  function onFocusOut(e) {
    if (e.isTrusted !== true) return;
    const t = realTarget(e);
    if (isPassword(t)) reuseCheck(t);
  }

  // ---------- messages from the extension (never from the page) ----------
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!sender || sender.id !== chrome.runtime.id || sender.tab) return false;
    if (msg && msg.type === "filled" && msg.host === topHost() && typeof msg.password === "string") {
      filled = { username: typeof msg.username === "string" ? msg.username : "", password: msg.password };
    }
    // A same-site frame captured a login; the offer card lives in the top frame.
    if (msg && msg.type === "checkPending" && IS_TOP) schedulePending(1200);
    // Alt+Shift+L (background): same as clicking the icon of the focused login field, else the first visible one.
    if (msg && msg.type === "fillShortcut") {
      if (!iconsOn()) { if (siteHidden()) shortcutOnHiddenSite(); return false; }
      const active = activeField();
      const field = icons.has(active) ? active : [...icons.keys()].find((f) => f.isConnected && shown(f));
      if (field && (active === field || document.hasFocus())) onIconClick(field);
    }
    return false;
  });

  // ---------- settings ----------
  function applySettings(s) {
    if ("offerSave" in s) settings.offerSave = s.offerSave !== false;
    if ("showIcon" in s) settings.showIcon = s.showIcon !== false;
    if ("suggestOnFocus" in s) settings.suggestOnFocus = s.suggestOnFocus === true;
    if ("theme" in s) { cachedTheme = NS.validateTheme(s.theme); applyThemeNow(); }
    if ("neverSave" in s) {
      settings.neverSave = Array.isArray(s.neverSave)
        ? s.neverSave.filter((h) => typeof h === "string").map((h) => h.toLowerCase()).slice(0, 1000)
        : [];
    }
    for (const k of ["hiddenSites", "reuseTrusted"]) {
      if (k in s) settings[k] = NS.hostList(s[k]);
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const s = {};
    for (const k of ["offerSave", "showIcon", "suggestOnFocus", "neverSave", "hiddenSites", "reuseTrusted", "theme"]) if (changes[k]) s[k] = changes[k].newValue;
    applySettings(s);
    scan();
    if (!iconsOn() && !(menu && menuIcons.has(menu.field))) closeMenu(false);
    if (!iconsOn() || !settings.suggestOnFocus) hideSuggest();
    if (warn && settings.reuseTrusted.includes(topHost())) closeWarn();
    if (bar && !settings.offerSave) closeBar(false);
  });

  // ---------- wiring ----------
  // Scans are coalesced and run when the page is idle (requestIdleCallback, else a
  // timeout), at most one every 250 ms. A page that keeps changing but shows no login,
  // card or code field backs off: after 6 empty scans mutations wait 1.5 s, after 15
  // they wait 5 s, and after 30 the observer stops scanning until the user focuses an
  // input or the URL changes (SPA route), which also scans at once. The observer
  // ignores class / style changes (most of a busy page's churn); a form revealed that
  // way is found on the first focus into it.
  const SCAN_GAP = 250, EMPTY_SLOW = 6, EMPTY_SLOWER = 15, EMPTY_STOP = 30;
  const idle = typeof requestIdleCallback === "function"
    ? (fn) => requestIdleCallback(fn, { timeout: 600 })
    : (fn) => setTimeout(fn, 0);
  let scanTimer = 0, scanDue = 0, emptyScans = 0, lastHref = location.href;
  const scanDelay = () => (emptyScans >= EMPTY_SLOWER ? 5000 : emptyScans >= EMPTY_SLOW ? 1500 : SCAN_GAP);
  function scheduleScan(delay = scanDelay()) {
    if (emptyScans >= EMPTY_STOP && delay > SCAN_GAP) return; // dormant until woken
    const due = Date.now() + delay;
    if (scanTimer) {
      if (due >= scanDue) return; // one is already coming soon enough
      clearTimeout(scanTimer);
    }
    scanDue = due;
    scanTimer = setTimeout(() => idle(() => { scanTimer = 0; scan(); }), delay);
  }
  function wakeScans() {
    emptyScans = 0;
    scheduleScan(SCAN_GAP);
  }
  function noteScanResult(found) {
    emptyScans = found ? 0 : Math.min(emptyScans + 1, EMPTY_STOP);
  }
  function onUrlMaybeChanged() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    wakeScans();
    schedulePending(800);
  }
  const MO_OPTS = { childList: true, subtree: true, attributes: true,
    attributeFilter: ["type", "hidden", "disabled", "aria-hidden"] };
  const mo = new MutationObserver((muts) => {
    if (shadowHost && muts.every((m) => m.target === shadowHost ||
      (m.type === "childList" && [...m.addedNodes, ...m.removedNodes].every((n) => n === shadowHost)))) return;
    onUrlMaybeChanged();
    scheduleScan();
  });
  mo.observe(document.documentElement, MO_OPTS);

  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("focusout", onFocusOut, true);
  window.addEventListener("blur", () => hideSuggest());
  window.addEventListener("scroll", schedulePosition, { capture: true, passive: true });
  window.addEventListener("resize", schedulePosition, { passive: true });
  window.addEventListener("popstate", onUrlMaybeChanged);
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("navigatesuccess", onUrlMaybeChanged);
  }

  chrome.storage.local.get({ offerSave: true, showIcon: true, suggestOnFocus: false, neverSave: [], hiddenSites: [], reuseTrusted: [], theme: null }, (s) => {
    applySettings(s || {});
    scan();
    schedulePending(300);
  });
  } // main
})();
