// Notiq Autofill — service worker. Talks to the Notiq app through the native host.
// shared.js (validateTheme etc.): importScripts in the Chromium service worker; the
// Firefox build lists it in background.scripts before this file instead.
if (typeof importScripts === "function" && !globalThis.NotiqShared) importScripts("shared.js");
// identity.js (identity reply validation): loaded the same way (Firefox: listed in background.scripts).
if (typeof importScripts === "function" && !globalThis.NotiqIdentity) importScripts("identity.js");
const HOST = "com.trexolab.notiq";
const PENDING_TTL = 90 * 1000;
const MAX = { host: 253, url: 2048, title: 80, username: 512, password: 1024, message: 8192, neverSave: 500,
  choices: 20, account: 256, choiceTitle: 200 };
const SETTINGS_DEFAULTS = { offerSave: true, showIcon: true, suggestOnFocus: false, neverSave: [] };
const OFFER_TTL = 2 * 60 * 1000;

// The one same-site rule (Public Suffix List based), from shared.js.
const sameSite = (host, top) => NotiqShared.sameSite(host, top);
let EXT_VERSION = "";
try { EXT_VERSION = String(chrome.runtime.getManifest().version || "").slice(0, 32); } catch { /* test stub */ }

// Every request names this extension's version and protocol (see NotiqShared.PROTOCOL); older apps ignore both.
function ask(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, { ...msg, ext: EXT_VERSION, protocol: NotiqShared.PROTOCOL }, (res) => {
      if (chrome.runtime.lastError) resolve({ error: "no_host", detail: chrome.runtime.lastError.message });
      else {
        // Vault locked: no held password survives that.
        if (res && (res.error === "locked" || res.locked === true)) { dropAllSteps().catch(() => {}); dropIdentityMenu(); }
        resolve(res || { error: "no_reply" });
      }
    });
  });
}

// Asks the app (never starts it) whether the vault is open. Anything but a clear "running, not locked"
// (app closed, no host, an error) counts as locked: a closed app has a locked vault. An older app whose
// ping says nothing about the lock counts as unlocked (its "locked" error replies still drop held passwords).
async function appUnlocked() {
  const res = await ask({ op: "ping" });
  const ok = !!res && res.ok === true && res.locked !== true;
  if (!ok) await dropAllSteps().catch(() => {});
  return ok;
}

// Toolbar fill, phase 1: runs in EVERY frame of the tab and carries no secret. Each frame reports only its
// own origin, its ancestors' origins and whether it shows fillable / password inputs; the background decides
// (NotiqShared.fillTargetOk, Public Suffix List rule) which frames may receive the login. Self-contained:
// executeScript serializes it, so it may not use anything outside its body.
function probeFrame() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.disabled && !el.readOnly;
  };
  const kinds = ["text", "email", "tel", "password", "number", ""];
  const inputs = [...document.querySelectorAll("input")].filter((i) => kinds.includes(i.type) && visible(i));
  let ancestors = null;
  try { if (location.ancestorOrigins) ancestors = [...location.ancestorOrigins]; } catch { ancestors = null; }
  return {
    origin: location.origin, top: window.top === window, ancestors,
    fields: inputs.length > 0, password: inputs.some((i) => i.type === "password"),
  };
}

// Toolbar fill, phase 2: injected ONLY into the frames phase 1 approved (by documentId, else frameId).
// `host` is the TOP page's host and `scope` = { top: top origin, allowed: [origins checked same-site in
// phase 1] }. The frame re-checks that it is still that document's origin (it may have navigated since the
// probe), so credentials are never typed into another site's frame. Self-contained (serialized, no closures).
function fillPage(host, cred, scope) {
  if (!scope || typeof scope.top !== "string" || !Array.isArray(scope.allowed)) return 0;
  if (window.top === window) {
    if (location.origin !== scope.top || location.hostname.toLowerCase() !== host) return 0;
  } else {
    if (!scope.allowed.includes(location.origin)) return 0;
    let ao = null;
    try { ao = location.ancestorOrigins; } catch { ao = null; }
    if (!ao || !ao.length || ao[ao.length - 1] !== scope.top) return 0;
    for (let i = 0; i < ao.length; i++) if (!scope.allowed.includes(ao[i])) return 0;
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.disabled && !el.readOnly;
  };
  const set = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    el.focus();
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const all = [...document.querySelectorAll("input")].filter(visible);
  const pw = all.find((i) => i.type === "password");
  const textual = (i) => ["text", "email", "tel", ""].includes(i.type) || !i.type;
  let n = 0;
  const otpLike = (i) => i.autocomplete === "one-time-code" ||
    /otp|totp|2fa|mfa|verification|security.?code|one.?time/i.test(`${i.name} ${i.id} ${i.placeholder}`);
  // Split code boxes: 4–8 consecutive single-character inputs.
  let boxes = null;
  {
    const runs = [];
    let run = [];
    for (const i of document.querySelectorAll("input")) {
      if (i.type === "hidden") continue;
      if (["text", "tel", "number"].includes(i.type) && i.maxLength === 1 && visible(i)) { run.push(i); continue; }
      if (run.length) runs.push(run);
      run = [];
    }
    if (run.length) runs.push(run);
    boxes = runs.find((r) => r.length >= 4 && r.length <= 8 &&
      r.some((i) => otpLike(i) || i.inputMode === "numeric" || i.type === "number")) || null;
  }
  const otp = all.find((i) => textual(i) && i.maxLength !== 1 && otpLike(i));
  const used = [];
  if (otp) used.push(otp);
  if (boxes) used.push(...boxes);
  if (pw) {
    const form = pw.form || document;
    const candidates = [...form.querySelectorAll("input")].filter((i) => visible(i) && textual(i) && i !== otp && !(boxes && boxes.includes(i)));
    const before = candidates.filter((i) => pw.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING);
    const user = before.length ? before[before.length - 1] : null;
    if (user && cred.username) { set(user, cred.username); n++; used.push(user); }
    set(pw, cred.password); n++; used.push(pw);
  } else if (!otp && !boxes) {
    // Username-first flows: fill the only visible text/email field.
    const user = all.find((i) => textual(i) && /user|email|login|account/i.test(`${i.name} ${i.id} ${i.autocomplete} ${i.type}`)) || all.find(textual);
    if (user && cred.username) { set(user, cred.username); n++; used.push(user); }
  }
  const code = typeof cred.code === "string" ? cred.code : "";
  if (code && boxes && boxes.length === code.length && /^[0-9A-Za-z]+$/.test(code)) {
    boxes.forEach((b, k) => {
      const ch = code[k];
      b.focus();
      b.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(b), "value")?.set;
      if (setter) setter.call(b, ch); else b.value = ch;
      b.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      b.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      b.dispatchEvent(new Event("change", { bubbles: true }));
    });
    boxes[boxes.length - 1].focus();
    n++;
  } else if (otp && code) { set(otp, code); n++; }
  // The login's custom fields, by name (NotiqFill.matchCustomFields; same rules as the in-page fill). This
  // frame passed the same-site checks above, so secret ones may go here too, like the password.
  const FK = globalThis.NotiqFill;
  const fields = Array.isArray(cred.fields) ? cred.fields : [];
  if (fields.length && FK && typeof FK.matchCustomFields === "function") {
    const root = (pw && pw.form) || (used.find((el) => el.form) || {}).form || document; // the login's form, else the frame
    const els = [...root.querySelectorAll("input, textarea")].filter((el) => FK.customFillable(el) && visible(el) &&
      !used.includes(el) && el.maxLength !== 1 && !otpLike(el) &&
      !/(^|\s)(one-time-code|new-password|cc-[a-z-]+)(\s|$)/i.test(el.getAttribute("autocomplete") || ""));
    const active = document.activeElement;
    for (const p of FK.matchCustomFields(fields, els.map((el) => ({ texts: FK.describeField(el), value: el.value, clicked: false })),
      { allowSecret: true })) {
      set(els[p.field], fields[p.custom].value); n++;
    }
    if (active && active !== document.activeElement && active.focus) active.focus();
  }
  return n;
}

// Parses a page URL and applies the https-or-localhost rule. Returns
// { host, origin, url } or { error }.
function pageInfo(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return { error: "bad_url" }; }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return { error: "not_https" };
  const host = u.hostname.toLowerCase();
  if (!host || host.length > MAX.host) return { error: "bad_url" };
  return { host, origin: u.origin, url: (u.origin + u.pathname).slice(0, MAX.url) };
}

const str = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

// Lets the tab's content script know what was just filled, so submitting those
// same values doesn't trigger a "Save to Notiq?" offer. Extension-internal only.
// Sent only to the frames that were just filled (they already hold these values).
function notifyFilled(tabId, host, res, frameIds = [0]) {
  for (const frameId of frameIds) {
    try {
      chrome.tabs.sendMessage(tabId, {
        type: "filled", host,
        username: typeof res.username === "string" ? res.username : "",
        password: typeof res.password === "string" ? res.password : "",
      }, { frameId }, () => void chrome.runtime.lastError);
    } catch { /* no content script on this page */ }
  }
}

// ---------- several logins match: the account chooser ----------
// The app may answer a fill with { choose: [{ account, title, username }] } (no
// secrets). We remember which account ids were offered for which tab + host and
// only accept a follow-up fill naming one of them.
const offers = new Map(); // tabId -> { host, accounts: Set, at }

function validChoices(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX.choices) return null;
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return null;
    if (typeof c.account !== "string" || typeof c.title !== "string" || typeof c.username !== "string") return null;
    if (!c.account || c.account.length > MAX.account || c.title.length > MAX.choiceTitle || c.username.length > MAX.username) return null;
    out.push({ account: c.account, title: str(c.title, MAX.choiceTitle), username: str(c.username, MAX.username) });
  }
  return out;
}

// A one-time code as the app sends it (TOTP: 6-8 digits; a little slack for other generators).
const CODE_RE = /^[0-9A-Za-z]{4,10}$/;

// Asks the app for a login for `host`, optionally a specific `account`. Returns
// { cred } | { choose } | { error }. `intent: "code"` (a separate 2FA page) asks for the
// login's one-time code only: the cred is then { username, title, code } and never holds a
// password, even if an older app that doesn't know the intent sends one.
async function askFill(tabId, host, account, intent) {
  if (account !== undefined) {
    if (typeof account !== "string" || !account || account.length > MAX.account) return { error: "bad_request" };
    const o = offers.get(tabId);
    if (!o || o.host !== host || !(Date.now() - o.at < OFFER_TTL) || !o.accounts.has(account)) return { error: "stale" };
  }
  const req = account !== undefined ? { op: "fill", host, account } : { op: "fill", host };
  if (intent === "code") req.intent = "code";
  const res = await ask(req);
  if (res && res.choose !== undefined && !res.error) {
    const list = account === undefined ? validChoices(res.choose) : null;
    if (!list) return { error: "no_reply" };
    offers.set(tabId, { host, accounts: new Set(list.map((c) => c.account)), at: Date.now() });
    return { choose: list };
  }
  offers.delete(tabId);
  if (!res || res.error) return { error: res ? String(res.error).slice(0, 40) : "no_reply" };
  if (intent === "code") {
    if (res.ok !== true || typeof res.code !== "string" || !CODE_RE.test(res.code)) return { error: "no_code" };
    return { cred: { username: str(res.username, MAX.username), title: str(res.title, 200), code: res.code } };
  }
  if (typeof res.password !== "string") return { error: "no_reply" };
  return { cred: res };
}

async function fillActiveTab(account) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return { error: "no_tab" };
  const top = pageInfo(tab.url);
  if (top.error) return { error: top.error };
  const host = top.host;
  await dropStep(tab.id); // a new fill in this tab replaces any held password
  const got = await askFill(tab.id, host, account);
  if (got.error) return { error: got.error };
  if (got.choose) return { choose: got.choose, host };
  const res = got.cred;
  // Phase 1: which frames may get it (secret-free probe in every frame).
  let probes;
  try {
    probes = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: probeFrame });
  } catch {
    return { error: "no_fields" };
  }
  const targets = (Array.isArray(probes) ? probes : []).filter((r) => r && NotiqShared.fillTargetOk(r.result, r.frameId, top.origin));
  if (!targets.length) return { error: "no_fields" };
  // Username-first page (no password field in any eligible frame): fill the username now and hold the
  // password for the next step of this sign-in.
  const step = typeof res.username === "string" && !!res.username && !targets.some((r) => r.result.password === true);
  const allowed = [...new Set(targets.flatMap((r) => [r.result.origin, ...(r.frameId === 0 ? [] : r.result.ancestors)]))];
  // Phase 2: the login goes only to those frames. documentIds pin the exact documents that were probed
  // (Chromium); Firefox has no documentId, so frameIds there (fillPage re-checks the origin either way).
  const byDoc = targets.every((r) => typeof r.documentId === "string" && r.documentId);
  const target = byDoc
    ? { tabId: tab.id, documentIds: targets.map((r) => r.documentId) }
    : { tabId: tab.id, frameIds: targets.map((r) => r.frameId) };
  // The custom-field matcher (fillkit.js) is normally there already as a content script; loading it again is harmless.
  const fields = NotiqShared.validCustomFields(res.fields);
  if (fields.length) {
    try { await chrome.scripting.executeScript({ target, files: ["fillkit.js"] }); } catch { /* custom fields are skipped */ }
  }
  let out;
  try {
    out = await chrome.scripting.executeScript({
      target,
      func: fillPage,
      args: [host, { username: res.username, password: step ? "" : res.password, code: res.code, fields }, { top: top.origin, allowed }],
    });
  } catch {
    return { error: "no_fields" };
  }
  const frames = (Array.isArray(out) ? out : []).filter((r) => r && r.result > 0).map((r) => r.frameId);
  if (frames.length && step) await armStep(tab.id, host, account, res);
  if (frames.length) notifyFilled(tab.id, host, step ? { ...res, password: "" } : res, frames);
  return frames.length ? { ok: true, host, title: str(res.title, 200) } : { error: "no_fields" };
}

// ---------- requests from the in-page content script ----------
// Top frame: everything. Same-site subframes (checked against the tab's real
// URL): only "fill", "capture" and "fillCard".
const fillsInFlight = new Set();
const savesInFlight = new Set();
const pendingKey = (tabId) => `pending:${tabId}`;
const FRAME_TYPES = new Set(["fill", "capture", "fillCard", "stepFill", "stepCancel"]);

// The top page of the sender's tab. For the top frame that is the sender's own
// URL; for a subframe it is the tab URL (never anything from the message).
const topInfo = (sender) => pageInfo(sender.frameId === 0 ? sender.url : sender.tab.url);
function frameAllowed(sender) {
  const top = pageInfo(sender.tab.url);
  const frame = pageInfo(sender.url);
  return !top.error && !frame.error && sameSite(frame.host, top.host);
}

// The in-page icon was clicked (a trusted click, checked in content.js). The
// host comes from the top page's URL, never from the message. Credentials go
// back only to the content script (frame) that asked, which fills its own page.
async function fillForSender(sender, msg) {
  const info = topInfo(sender);
  if (info.error) return { error: info.error };
  if (sender.tab.active === false) return { error: "denied" };
  const tabId = sender.tab.id;
  // `intent: "code"`: the one-time code field of a separate 2FA page (see askFill).
  if (msg && msg.intent !== undefined && msg.intent !== "code") return { error: "bad_request" };
  const intent = msg && msg.intent === "code" ? "code" : undefined;
  if (fillsInFlight.has(tabId)) return { error: "busy" };
  fillsInFlight.add(tabId);
  try {
    if (!intent) await dropStep(tabId); // a new fill in this tab replaces any held password
    const account = msg && msg.account !== undefined ? msg.account : undefined;
    const got = await askFill(tabId, info.host, account, intent);
    if (got.error) return { error: got.error };
    if (got.choose) return { choose: got.choose, host: info.host };
    const res = got.cred;
    if (intent) return { ok: true, host: info.host, title: res.title, username: res.username, code: res.code };
    // The content script says this is a username-only page: the password stays here
    // for the next step instead of going to the page now.
    const step = !!(msg && msg.step === true && typeof res.username === "string" && res.username);
    if (step) await armStep(tabId, info.host, account, res);
    return {
      ok: true, host: info.host, title: str(res.title, 200),
      username: typeof res.username === "string" ? res.username : "",
      password: step ? "" : res.password,
      code: typeof res.code === "string" ? res.code : "",
      fields: NotiqShared.validCustomFields(res.fields), // the login's custom fields (filled by name)
    };
  } finally {
    fillsInFlight.delete(tabId);
  }
}

// ---------- payment cards ----------
// The in-page card icon was clicked (trusted click, checked in content.js). Same rules as a login fill:
// the host and origin come from the top page's URL (https, or http on localhost), the sender is the top
// frame or a same-site subframe (checked before this runs), and the card goes back only to that frame.
// The app always asks the user to pick the card; the reply is re-validated here before it is passed on.
async function fillCardForSender(sender) {
  const info = topInfo(sender);
  if (info.error) return { error: info.error };
  if (sender.tab.active === false) return { error: "denied" };
  const tabId = sender.tab.id;
  if (fillsInFlight.has(tabId)) return { error: "busy" };
  fillsInFlight.add(tabId);
  try {
    const res = await ask({ op: "fill_card", host: info.host, origin: info.origin });
    if (!res || res.error) return { error: res ? String(res.error).slice(0, 40) : "no_reply" };
    const card = NotiqShared.validCardReply(res);
    return card ? { ok: true, host: info.host, card } : { error: "no_reply" };
  } finally {
    fillsInFlight.delete(tabId);
  }
}

async function getSettings() {
  const s = await chrome.storage.local.get(SETTINGS_DEFAULTS);
  return {
    offerSave: s.offerSave !== false,
    showIcon: s.showIcon !== false,
    suggestOnFocus: s.suggestOnFocus === true,
    neverSave: Array.isArray(s.neverSave) ? s.neverSave.filter((h) => typeof h === "string").map((h) => h.toLowerCase()) : [],
  };
}

async function purgeExpired() {
  const all = await chrome.storage.session.get(null);
  const now = Date.now();
  const stale = Object.keys(all).filter((k) => k.startsWith("pending:") && !(all[k] && now - all[k].at < PENDING_TTL));
  if (stale.length) await chrome.storage.session.remove(stale);
}

async function readPending(tabId) {
  const key = pendingKey(tabId);
  const got = await chrome.storage.session.get(key);
  const p = got[key];
  if (!p) return null;
  if (!(Date.now() - p.at < PENDING_TTL)) { await chrome.storage.session.remove(key); return null; }
  return p;
}

const CAPTURE_KEYS = ["host", "url", "username", "password", "title"];
async function onCapture(msg, sender) {
  const p = msg.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return { error: "bad_request" };
  if (Object.keys(p).some((k) => !CAPTURE_KEYS.includes(k) && k !== "change")) return { error: "bad_request" };
  if (!CAPTURE_KEYS.every((k) => typeof p[k] === "string")) return { error: "bad_request" };
  if (p.change !== undefined && typeof p.change !== "boolean") return { error: "bad_request" };
  if (!p.password || p.password.length > MAX.password || p.username.length > MAX.username) return { error: "bad_request" };
  const info = pageInfo(sender.url);
  if (info.error) return { error: info.error };
  // The payload's host must be the sender page's own host.
  if (p.host.toLowerCase() !== info.host) return { error: "bad_request" };
  // A login captured in a same-site frame is saved for the top page's site.
  const top = sender.frameId === 0 ? info : topInfo(sender);
  if (top.error) return { error: top.error };
  const settings = await getSettings();
  if (!settings.offerSave || settings.neverSave.includes(top.host)) return { ok: false, skipped: true };
  // SPAs change the path without the sender URL following; accept the page's
  // url only when it is on the same origin, else use the sender's.
  let url = top.url;
  const claimed = pageInfo(p.url);
  if (sender.frameId === 0 && !claimed.error && claimed.origin === info.origin) url = claimed.url;
  await purgeExpired();
  await chrome.storage.session.set({
    [pendingKey(sender.tab.id)]: {
      host: top.host, url, username: str(p.username, MAX.username), password: p.password,
      title: str(p.title, MAX.title), change: p.change === true, at: Date.now(),
    },
  });
  if (sender.frameId !== 0) {
    // The offer card is shown by the top frame; ask it to look (no secrets in this message).
    try { chrome.tabs.sendMessage(sender.tab.id, { type: "checkPending" }, { frameId: 0 }, () => void chrome.runtime.lastError); } catch { /* none */ }
  }
  return { ok: true };
}

async function onPending(_msg, sender) {
  const p = await readPending(sender.tab.id);
  // Never hand the password back to the page side.
  return { pending: p ? { host: p.host, username: p.username, change: p.change === true } : null };
}

const SAVE_STATUS = new Set(["saved", "updated", "unchanged"]);
async function onSave(_msg, sender) {
  const tabId = sender.tab.id;
  if (savesInFlight.has(tabId)) return { error: "busy" };
  const p = await readPending(tabId);
  if (!p) return { error: "expired" };
  savesInFlight.add(tabId);
  try {
    const res = await ask({ op: "save", host: p.host, url: p.url, username: p.username, password: p.password, title: p.title });
    if (res && res.ok) {
      await chrome.storage.session.remove(pendingKey(tabId));
      return { ok: true, status: SAVE_STATUS.has(res.status) ? res.status : "saved" };
    }
    const error = res && typeof res.error === "string" ? res.error.slice(0, 40) : "no_reply";
    if (error === "denied" || error === "bad_request") await chrome.storage.session.remove(pendingKey(tabId));
    return { error };
  } finally {
    savesInFlight.delete(tabId);
  }
}

async function onDismiss(_msg, sender) {
  await chrome.storage.session.remove(pendingKey(sender.tab.id));
  return { ok: true };
}

async function onNever(_msg, sender) {
  const p = await readPending(sender.tab.id);
  const info = pageInfo(sender.url);
  const host = p ? p.host : info.host;
  await chrome.storage.session.remove(pendingKey(sender.tab.id));
  if (!host) return { error: "bad_request" };
  const { neverSave } = await getSettings();
  if (!neverSave.includes(host)) {
    neverSave.push(host);
    await chrome.storage.local.set({ neverSave: neverSave.slice(-MAX.neverSave) });
  }
  return { ok: true };
}

// ---------- multi-step logins (username page, then password page) ----------
// Google, Microsoft and most SSO pages ask for the username, then show the password
// field after "Next" (an SPA re-render or a navigation). A fill approved on the
// username page fills only the username; the password waits here for the next step:
// in chrome.storage.session (memory only, not readable by content scripts), bound to
// the tab, the approved top host's site and the account, for STEP_TTL. It is handed
// out once, to a content script of that tab whose top page is still on that site, and
// dropped on use, expiry, tab close, navigation to another site, a new fill in the
// tab, a "locked" reply from Notiq, or a ping that finds the vault locked or Notiq
// closed (checked before every hand-out and whenever the popup opens). Nothing is
// ever submitted for the user.
const STEP_TTL = 2 * 60 * 1000;
const stepKey = (tabId) => `step:${tabId}`;

async function armStep(tabId, host, account, res) {
  await chrome.storage.session.set({
    [stepKey(tabId)]: {
      host, account: typeof account === "string" ? account : "", username: res.username, password: res.password,
      fields: NotiqShared.validCustomFields(res.fields), at: Date.now(),
    },
  });
  setTimeout(() => { purgeSteps().catch(() => {}); }, STEP_TTL + 1000); // best effort; reads re-check the age anyway
}
const dropStep = (tabId) => chrome.storage.session.remove(stepKey(tabId));
const stepFresh = (p, now) => !!p && typeof p.at === "number" && now - p.at < STEP_TTL && now >= p.at;
async function dropAllSteps() {
  const keys = Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith("step:"));
  if (keys.length) await chrome.storage.session.remove(keys);
}
async function purgeSteps() {
  const all = await chrome.storage.session.get(null);
  const now = Date.now();
  const stale = Object.keys(all).filter((k) => k.startsWith("step:") && !stepFresh(all[k], now));
  if (stale.length) await chrome.storage.session.remove(stale);
}

// A content script saw an empty login password field appear. Only the tab that holds
// a password gets it, only while its top page is on the approved site, only while Notiq
// says the vault is still unlocked (asked every time; a lock drops every held password),
// and only once.
const stepsInFlight = new Set();
async function onStepFill(_msg, sender) {
  const tabId = sender.tab.id;
  if (stepsInFlight.has(tabId)) return { none: true };
  stepsInFlight.add(tabId);
  try {
    const key = stepKey(tabId);
    const p = (await chrome.storage.session.get(key))[key];
    if (!p) return { none: true };
    const info = topInfo(sender);
    if (info.error || !sameSite(info.host, p.host) || !stepFresh(p, Date.now()) || typeof p.password !== "string") {
      await dropStep(tabId);
      return { none: true };
    }
    if (sender.tab.active === false) return { none: true };
    if (!(await appUnlocked())) return { none: true }; // appUnlocked dropped it
    const again = (await chrome.storage.session.get(key))[key]; // still the same hold (no new fill / drop meanwhile)?
    if (!again || again.at !== p.at || again.password !== p.password) return { none: true };
    await dropStep(tabId);
    return {
      ok: true, host: info.host, username: typeof p.username === "string" ? p.username : "", password: p.password,
      fields: NotiqShared.validCustomFields(p.fields),
    };
  } finally {
    stepsInFlight.delete(tabId);
  }
}
// The username fill did not happen after all (field gone, nothing filled).
async function onStepCancel(_msg, sender) {
  await dropStep(sender.tab.id);
  return { ok: true };
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // The URL is only visible with host access to the page; otherwise the site check in onStepFill covers it.
  if (!changeInfo || typeof changeInfo.url !== "string") return;
  const key = stepKey(tabId);
  chrome.storage.session.get(key).then((got) => {
    const p = got[key];
    if (!p) return;
    const info = pageInfo(changeInfo.url);
    if (info.error || !sameSite(info.host, p.host)) return dropStep(tabId);
  }).catch(() => {});
});
purgeSteps().catch(() => {}); // service-worker start

// ---------- toolbar popup: this site's logins, copy, open (0.9.0) ----------
// Only the popup (an extension page, never a content script) may ask. The host is always the active tab's top
// host from its URL. The app answers `list` with titles and usernames of the logins that match that host (no
// secrets, nothing for other sites); `copy` is done by the app itself (the value never comes here) and `open`
// only shows Notiq. A row action must name an account from this tab's latest list for the same host.
// An app older than 0.9.0 answers { error: "unknown_op" }; the popup then says to update Notiq.
const POPUP_LIST_TTL = 10 * 60 * 1000;
const POPUP_MAX_ACCOUNTS = 50;
const COPY_WHAT = new Set(["username", "password", "code"]);
const popupLists = new Map(); // tabId -> { host, accounts: Set, at }

function validListed(list) {
  if (!Array.isArray(list) || list.length > POPUP_MAX_ACCOUNTS) return null;
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== "object" || Array.isArray(a)) return null;
    if (typeof a.account !== "string" || typeof a.title !== "string" || typeof a.username !== "string") return null;
    if (!a.account || a.account.length > MAX.account || a.title.length > MAX.choiceTitle || a.username.length > MAX.username) return null;
    out.push({ account: a.account, title: str(a.title, MAX.choiceTitle), username: str(a.username, MAX.username), totp: a.totp === true });
  }
  return out;
}

async function popupTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number" || !tab.url) return { error: "no_tab" };
  const top = pageInfo(tab.url);
  return top.error ? { error: top.error } : { tab, host: top.host };
}

const errorOf = (res) => (res && typeof res.error === "string" ? res.error.slice(0, 40) : "no_reply");

async function popupList() {
  const t = await popupTab();
  if (t.error) return { error: t.error };
  popupLists.delete(t.tab.id);
  const res = await ask({ op: "list", host: t.host });
  if (!res || res.error || res.ok !== true) return { error: errorOf(res), host: t.host };
  const accounts = validListed(res.accounts);
  if (!accounts) return { error: "no_reply", host: t.host };
  popupLists.set(t.tab.id, { host: t.host, accounts: new Set(accounts.map((a) => a.account)), at: Date.now() });
  return { ok: true, host: t.host, accounts };
}

// The active tab, if `account` is in its latest popup list for the same host.
async function popupListed(account) {
  if (typeof account !== "string" || !account || account.length > MAX.account) return { error: "bad_request" };
  const t = await popupTab();
  if (t.error) return { error: t.error };
  const l = popupLists.get(t.tab.id);
  const fresh = l && l.host === t.host && Date.now() - l.at < POPUP_LIST_TTL && Date.now() >= l.at;
  return fresh && l.accounts.has(account) ? t : { error: "stale" };
}

// A row was clicked: the normal toolbar fill (app approval) for that account.
async function popupFill(msg) {
  const t = await popupListed(msg.account);
  if (t.error) return { error: t.error };
  offers.set(t.tab.id, { host: t.host, accounts: new Set([msg.account]), at: Date.now() });
  return fillActiveTab(msg.account);
}

async function popupCopy(msg) {
  if (!COPY_WHAT.has(msg.what)) return { error: "bad_request" };
  const t = await popupListed(msg.account);
  if (t.error) return { error: t.error };
  const res = await ask({ op: "copy", host: t.host, account: msg.account, what: msg.what });
  if (!res || res.error || res.ok !== true) return { error: errorOf(res) };
  const clearAfter = Number.isInteger(res.clearAfter) && res.clearAfter >= 0 && res.clearAfter <= 3600 ? res.clearAfter : 0;
  return { ok: true, copied: msg.what, clearAfter };
}

async function popupOpen(msg) {
  const t = await popupListed(msg.account);
  if (t.error) return { error: t.error };
  const res = await ask({ op: "open", host: t.host, account: msg.account });
  return res && res.ok === true && !res.error ? { ok: true } : { error: errorOf(res) };
}

const POPUP_HANDLERS = { list: popupList, popupFill, copy: popupCopy, open: popupOpen };

// ---------- theme from the Notiq app ----------
// {op:"theme"} -> {ok:true, theme} | {ok:true, theme:null}. Never launches the app.
// The validated theme is cached in chrome.storage.local `theme`; the popup and the
// content scripts read it from there (and re-validate it) and follow changes live.
const THEME_MIN_AGE = 60 * 1000;
let themeInFlight = null;
async function refreshTheme(minAge = 0) {
  if (themeInFlight) return themeInFlight;
  themeInFlight = (async () => {
    try {
      const { themeAt } = await chrome.storage.session.get("themeAt");
      if (minAge && typeof themeAt === "number" && Date.now() - themeAt < minAge && Date.now() >= themeAt) {
        return (await chrome.storage.local.get("theme")).theme || null;
      }
      await chrome.storage.session.set({ themeAt: Date.now() });
      const got = NotiqShared.themeReplyAction(await ask({ op: "theme" }));
      const cur = NotiqShared.validateTheme((await chrome.storage.local.get("theme")).theme);
      if (got.action === "set") {
        if (!NotiqShared.sameTheme(cur, got.theme)) await chrome.storage.local.set({ theme: got.theme });
        return got.theme;
      }
      if (got.action === "clear") {
        if ((await chrome.storage.local.get("theme")).theme !== undefined) await chrome.storage.local.remove("theme");
        return null;
      }
      return cur; // unreachable / malformed reply: keep what we have
    } finally {
      themeInFlight = null;
    }
  })();
  return themeInFlight;
}
// Content scripts only nudge (at most one host round trip per minute); they read the theme from storage.
const onThemeNudge = () => refreshTheme(THEME_MIN_AGE).then(() => ({ ok: true }), () => ({ ok: true }));

const CONTENT_HANDLERS = {
  fill: (m, s) => fillForSender(s, m),
  fillCard: (_m, s) => fillCardForSender(s),
  capture: onCapture,
  pending: onPending,
  save: onSave,
  dismiss: onDismiss,
  never: onNever,
  theme: onThemeNudge,
  stepFill: onStepFill,
  stepCancel: onStepCancel,
};

function messageTooBig(msg) {
  try { return JSON.stringify(msg).length > MAX.message; } catch { return true; }
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  // Only this extension's own popup and content scripts.
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string" || messageTooBig(msg)) return false;

  if (sender.tab) {
    // Content script of a real tab: the top frame, or a same-site subframe for fill/capture only.
    if (typeof sender.tab.id !== "number" || sender.tab.id < 0 || typeof sender.url !== "string" || typeof sender.frameId !== "number") return false;
    if (sender.frameId !== 0 && (!FRAME_TYPES.has(msg.type) || !frameAllowed(sender))) return false;
    const handler = Object.prototype.hasOwnProperty.call(CONTENT_HANDLERS, msg.type) ? CONTENT_HANDLERS[msg.type] : null;
    if (!handler) return false;
    handler(msg, sender).then(send, () => send({ error: "failed" }));
    return true;
  }

  // Extension pages (the popup).
  if (typeof sender.url === "string" && !sender.url.startsWith(chrome.runtime.getURL(""))) return false;
  if (Object.prototype.hasOwnProperty.call(POPUP_HANDLERS, msg.type)) {
    POPUP_HANDLERS[msg.type](msg).then(send, () => send({ error: "failed" }));
    return true;
  }
  if (msg.type === "fill") {
    fillActiveTab(msg.account !== undefined ? msg.account : undefined).then(send, () => send({ error: "failed" }));
    return true;
  }
  if (msg.type === "ping") {
    // The popup opened: also the moment to drop any held password if the vault is locked (or Notiq closed).
    ask({ op: "ping" }).then(async (res) => {
      if (!(res && res.ok === true && res.locked !== true)) await dropAllSteps().catch(() => {});
      send(res);
    });
    return true;
  }
  if (msg.type === "theme") {
    refreshTheme(0).then((theme) => send({ ok: true, theme }), () => send({ ok: true, theme: null }));
    return true;
  }
  return false;
});

// Alt+Shift+L: tell the page to behave as if its Notiq icon was clicked (the focused login field,
// else the first one). The page handles approval, chooser and errors exactly as for a click.
// With the page icon turned off there is nothing to click, so the shortcut opens the toolbar popup instead.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "fill-login") return;
  if (!(await getSettings()).showIcon) { try { await chrome.action.openPopup(); } catch { /* needs a recent Chrome/Edge */ } return; }
  const send = (t) => t && typeof t.id === "number" && chrome.tabs.sendMessage(t.id, { type: "fillShortcut" }).catch(() => {});
  if (tab) send(tab); else chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => send(t));
});

// Service-worker start (it also restarts after idling, hence the throttle).
refreshTheme(THEME_MIN_AGE).catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  offers.delete(tabId);
  popupLists.delete(tabId);
  chrome.storage.session.remove(pendingKey(tabId));
  dropStep(tabId);
});

// ---------- identities: in-page identity icon and the right-click menu ----------
// fill_identity follows the card rules: host and origin come from the top page's URL (https, or http on
// localhost), the sender is the top frame or a same-site subframe, and the identity goes back only to that
// frame. Notiq always asks the user to pick the identity and names the site that gets it; `account` only
// pre-selects one. `identities` (titles only, no field values) is answered only while the vault is unlocked and
// never starts Notiq; the titles live in session memory just for the right-click menu and are dropped when
// Notiq reports the vault locked or can't be reached.
const NI = globalThis.NotiqIdentity;
const accountArgOk = (a) => a === undefined ||
  (typeof a === "string" && a.length > 0 && a.length <= 512 && !/[\u0000-\u001f\u007f]/.test(a));

async function fillIdentityForSender(sender, msg) {
  const info = topInfo(sender);
  if (info.error) return { error: info.error };
  if (sender.tab.active === false) return { error: "denied" };
  const account = msg && msg.account !== undefined ? msg.account : undefined;
  if (!accountArgOk(account)) return { error: "bad_request" };
  const tabId = sender.tab.id;
  if (fillsInFlight.has(tabId)) return { error: "busy" };
  fillsInFlight.add(tabId);
  try {
    const req = { op: "fill_identity", host: info.host, origin: info.origin };
    if (account) req.account = account;
    const res = await ask(req);
    if (!res || res.error) return { error: res ? String(res.error).slice(0, 40) : "no_reply" };
    const identity = NI ? NI.validIdentityReply(res) : null;
    return identity ? { ok: true, host: info.host, identity } : { error: "no_reply" };
  } finally {
    fillsInFlight.delete(tabId);
  }
}

// The menu: Notiq > Fill login · Fill 2FA code · Fill identity > (titles…, Choose identity…) · Generate password.
// Chromium's contextMenus and Firefox's menus share this API.
const MENUS = (globalThis.chrome && (chrome.menus || chrome.contextMenus)) || null;
const MENU = Object.freeze({
  root: "nq-root", login: "nq-login", code: "nq-code", identity: "nq-identity", choose: "nq-identity-choose",
  sep: "nq-identity-sep", generate: "nq-generate",
});
const MENU_IDENTITY = "nq-identity:"; // + index into the stored list
const IDENTITY_MENU_KEY = "identityMenu"; // chrome.storage.session: [{ account, title }] shown in the menu
const IDENTITY_MIN_AGE = 15 * 1000;
let identityAt = 0, identityInFlight = null, identityShown = 0;

const menuCall = (fn) => new Promise((resolve) => {
  try { fn(() => { void chrome.runtime.lastError; resolve(); }); } catch { resolve(); }
});
const menuAdd = (props) => menuCall((cb) => MENUS.create({ contexts: ["editable"], ...props }, cb));
const menuRemove = (id) => menuCall((cb) => MENUS.remove(id, cb));
// Menu titles treat "&" as an access-key marker.
const menuTitle = (s) => s.replace(/&/g, "&&");

async function storedIdentities() {
  const got = (await chrome.storage.session.get(IDENTITY_MENU_KEY))[IDENTITY_MENU_KEY];
  return (NI && Array.isArray(got) && NI.validIdentityList({ ok: true, identities: got })) || [];
}

// Puts `list` under "Fill identity", then a separator and "Choose identity…" (always there: it opens the
// in-page chooser, which can also ask Notiq to unlock).
let menuQueue = Promise.resolve();
function setIdentityMenu(list) {
  const run = async () => {
    const before = await storedIdentities();
    await chrome.storage.session.set({ [IDENTITY_MENU_KEY]: list });
    identityShown = list.length;
    if (!MENUS) return;
    for (let k = 0; k < before.length; k++) await menuRemove(`${MENU_IDENTITY}${k}`);
    await menuRemove(MENU.sep);
    await menuRemove(MENU.choose);
    for (let k = 0; k < list.length; k++) {
      await menuAdd({ id: `${MENU_IDENTITY}${k}`, parentId: MENU.identity, title: menuTitle(list[k].title) });
    }
    if (list.length) await menuAdd({ id: MENU.sep, parentId: MENU.identity, type: "separator" });
    await menuAdd({ id: MENU.choose, parentId: MENU.identity, title: "Choose identity…" });
  };
  menuQueue = menuQueue.then(run, run);
  return menuQueue;
}
function dropIdentityMenu() {
  if (identityShown) setIdentityMenu([]).catch(() => {});
}

async function buildMenus() {
  if (!MENUS) return;
  await menuCall((cb) => MENUS.removeAll(cb));
  await menuAdd({ id: MENU.root, title: "Notiq" });
  await menuAdd({ id: MENU.login, parentId: MENU.root, title: "Fill login" });
  await menuAdd({ id: MENU.code, parentId: MENU.root, title: "Fill 2FA code" });
  await menuAdd({ id: MENU.identity, parentId: MENU.root, title: "Fill identity" });
  await menuAdd({ id: MENU.generate, parentId: MENU.root, title: "Generate password" });
  await chrome.storage.session.remove(IDENTITY_MENU_KEY); // removeAll dropped the old title items too
  await setIdentityMenu([]);
}

// Asks Notiq for the identity titles (at most every 15 s unless `minAge` is 0) and updates the menu.
// Resolves to { list } or { error }.
function refreshIdentities(minAge = IDENTITY_MIN_AGE) {
  if (identityInFlight) return identityInFlight;
  const now = Date.now();
  if (minAge && now - identityAt < minAge && now >= identityAt) return storedIdentities().then((list) => ({ list }));
  identityAt = now;
  identityInFlight = (async () => {
    try {
      const res = await ask({ op: "identities" });
      const list = NI ? NI.validIdentityList(res) : null;
      await setIdentityMenu(list || []);
      if (list) return { list };
      return { error: res && typeof res.error === "string" ? res.error.slice(0, 40) : "no_reply" };
    } finally {
      identityInFlight = null;
    }
  })();
  return identityInFlight;
}

// The in-page identity chooser (after a trusted click on an identity field's icon).
async function listIdentitiesForSender(sender) {
  const info = topInfo(sender);
  if (info.error) return { error: info.error };
  const r = await refreshIdentities(0);
  return r.list ? { ok: true, identities: r.list } : { error: r.error };
}

// A menu item was clicked: tell the content script of the clicked frame (only), which acts on the field the
// menu was opened on with the same paths as its icon. Frames on another site have no content script running
// (it quits at once), and the frame is re-checked against the tab's URL here.
async function onMenuClick(info, tab) {
  const id = info && typeof info.menuItemId === "string" ? info.menuItemId : "";
  if (!id.startsWith("nq-") || !tab || typeof tab.id !== "number" || tab.id < 0) return;
  // The tab's URL, or the page URL the click reports (always there; activeTab may not have granted tab.url yet).
  const top = pageInfo(tab.url || info.pageUrl || "");
  if (top.error) return;
  const frameId = Number.isInteger(info.frameId) && info.frameId >= 0 ? info.frameId : 0;
  if (frameId !== 0) {
    const frame = pageInfo(info.frameUrl || "");
    if (frame.error || !sameSite(frame.host, top.host)) return;
  }
  let msg = null;
  if (id === MENU.login) msg = { action: "login" };
  else if (id === MENU.code) msg = { action: "code" };
  else if (id === MENU.generate) msg = { action: "generate" };
  else if (id === MENU.choose || id === MENU.identity) msg = { action: "chooseIdentity" };
  else if (id.startsWith(MENU_IDENTITY)) {
    const k = Number(id.slice(MENU_IDENTITY.length));
    const pick = Number.isInteger(k) ? (await storedIdentities())[k] : null;
    msg = pick ? { action: "identity", account: pick.account } : { action: "chooseIdentity" };
  }
  if (!msg) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "menuFill", ...msg }, { frameId });
  } catch { /* no content script in that frame */ }
}

const IDENTITY_HANDLERS = {
  fillIdentity: (m, s) => fillIdentityForSender(s, m),
  identities: (_m, s) => listIdentitiesForSender(s),
  // A content script saw the context menu open on an editable field (Chromium has no menus.onShown).
  menuOpening: () => refreshIdentities().then(() => ({ ok: true }), () => ({ ok: true })),
};
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab) return false;
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string" || messageTooBig(msg)) return false;
  if (!Object.prototype.hasOwnProperty.call(IDENTITY_HANDLERS, msg.type)) return false;
  if (typeof sender.tab.id !== "number" || sender.tab.id < 0 || typeof sender.url !== "string" || typeof sender.frameId !== "number") return false;
  if (sender.frameId !== 0 && !frameAllowed(sender)) return false;
  IDENTITY_HANDLERS[msg.type](msg, sender).then(send, () => send({ error: "failed" }));
  return true;
});

if (MENUS) {
  MENUS.onClicked.addListener((info, tab) => { onMenuClick(info, tab).catch(() => {}); });
  // Firefox: load the titles while the menu opens, then redraw it.
  if (MENUS.onShown) {
    MENUS.onShown.addListener((info) => {
      if (!info || !Array.isArray(info.contexts) || !info.contexts.includes("editable")) return;
      refreshIdentities().then(() => { try { MENUS.refresh(); } catch { /* closed meanwhile */ } }).catch(() => {});
    });
  }
  buildMenus().catch(() => {});
}
