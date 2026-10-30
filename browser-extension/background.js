// Notiq Autofill — service worker. Talks to the Notiq app through the native host.
// shared.js (validateTheme etc.): importScripts in the Chromium service worker; the
// Firefox build lists it in background.scripts before this file instead.
if (typeof importScripts === "function" && !globalThis.NotiqShared) importScripts("shared.js");
const HOST = "com.trexolab.notiq";
const PENDING_TTL = 90 * 1000;
const MAX = { host: 253, url: 2048, title: 80, username: 512, password: 1024, message: 8192, neverSave: 500,
  choices: 20, account: 256, choiceTitle: 200 };
const SETTINGS_DEFAULTS = { offerSave: true, showIcon: true, suggestOnFocus: false, neverSave: [] };
const OFFER_TTL = 2 * 60 * 1000;

// Conservative "same site" test for login iframes: the frame's host must equal
// or be a subdomain of the top page's site (its last two labels, or last three
// for example.co.uk-style hosts). Bare public suffixes and IPs only match exactly.
const SLD = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
const isIp = (h) => /^[\d.]+$/.test(h) || h.includes(":");
function siteOf(host) {
  const l = host.split(".");
  if (l.length >= 3 && l[l.length - 1].length === 2 && SLD.has(l[l.length - 2])) return l.slice(-3).join(".");
  return l.slice(-2).join(".");
}
function sameSite(host, top) {
  host = String(host || "").toLowerCase();
  top = String(top || "").toLowerCase();
  if (!host || !top) return false;
  if (host === top) return true;
  if (isIp(top) || isIp(host)) return false;
  const site = siteOf(top);
  const l = site.split(".");
  if (l.length < 2 || (l.length === 2 && l[1].length === 2 && SLD.has(l[0]))) return false;
  return host === site || host.endsWith(`.${site}`);
}

function ask(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, msg, (res) => {
      if (chrome.runtime.lastError) resolve({ error: "no_host", detail: chrome.runtime.lastError.message });
      else {
        if (res && res.error === "locked") dropAllSteps().catch(() => {}); // vault locked: no held password survives that
        resolve(res || { error: "no_reply" });
      }
    });
  });
}

// Runs inside the page (every frame). `host` is the TOP page's host: a frame is
// filled only when it is that host, or a same-site subframe whose ancestors are
// all same-site too, so credentials are never typed into another site's iframe.
function fillPage(host, cred) {
  const here = location.hostname.toLowerCase();
  if (here !== host) {
    const SLD = ["co", "com", "org", "net", "gov", "ac", "edu"];
    const isIp = (h) => /^[\d.]+$/.test(h) || h.includes(":");
    const sameSite = (h, top) => {
      if (!h || !top) return false;
      if (h === top) return true;
      if (isIp(h) || isIp(top)) return false;
      const l = top.split(".");
      const site = (l.length >= 3 && l[l.length - 1].length === 2 && SLD.includes(l[l.length - 2]) ? l.slice(-3) : l.slice(-2));
      if (site.length < 2 || (site.length === 2 && site[1].length === 2 && SLD.includes(site[0]))) return false;
      const s = site.join(".");
      return h === s || h.endsWith(`.${s}`);
    };
    if (window.top === window || !sameSite(here, host)) return 0;
    if (!(location.protocol === "https:" || (location.protocol === "http:" && (here === "localhost" || here === "127.0.0.1")))) return 0;
    const ao = location.ancestorOrigins;
    if (!ao || !ao.length) return 0;
    for (let i = 0; i < ao.length; i++) {
      let h;
      try { h = new URL(ao[i]).hostname.toLowerCase(); } catch { return 0; }
      if (!sameSite(h, host) || (i === ao.length - 1 && h !== host)) return 0;
    }
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
  if (pw) {
    const form = pw.form || document;
    const candidates = [...form.querySelectorAll("input")].filter((i) => visible(i) && textual(i) && i !== otp && !(boxes && boxes.includes(i)));
    const before = candidates.filter((i) => pw.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING);
    const user = before.length ? before[before.length - 1] : null;
    if (user && cred.username) { set(user, cred.username); n++; }
    set(pw, cred.password); n++;
  } else if (!otp && !boxes) {
    // Username-first flows: fill the only visible text/email field.
    const user = all.find((i) => textual(i) && /user|email|login|account/i.test(`${i.name} ${i.id} ${i.autocomplete} ${i.type}`)) || all.find(textual);
    if (user && cred.username) { set(user, cred.username); n++; }
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

// Asks the app for a login for `host`, optionally a specific `account`. Returns
// { cred } | { choose } | { error }.
async function askFill(tabId, host, account) {
  if (account !== undefined) {
    if (typeof account !== "string" || !account || account.length > MAX.account) return { error: "bad_request" };
    const o = offers.get(tabId);
    if (!o || o.host !== host || !(Date.now() - o.at < OFFER_TTL) || !o.accounts.has(account)) return { error: "stale" };
  }
  const res = await ask(account !== undefined ? { op: "fill", host, account } : { op: "fill", host });
  if (res && res.choose !== undefined && !res.error) {
    const list = account === undefined ? validChoices(res.choose) : null;
    if (!list) return { error: "no_reply" };
    offers.set(tabId, { host, accounts: new Set(list.map((c) => c.account)), at: Date.now() });
    return { choose: list };
  }
  offers.delete(tabId);
  if (!res || res.error) return { error: res ? String(res.error).slice(0, 40) : "no_reply" };
  if (typeof res.password !== "string") return { error: "no_reply" };
  return { cred: res };
}

async function fillActiveTab(account) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return { error: "no_tab" };
  let u;
  try { u = new URL(tab.url); } catch { return { error: "bad_url" }; }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return { error: "not_https" };
  const host = u.hostname.toLowerCase();
  await dropStep(tab.id); // a new fill in this tab replaces any held password
  const got = await askFill(tab.id, host, account);
  if (got.error) return { error: got.error };
  if (got.choose) return { choose: got.choose, host };
  const res = got.cred;
  // Username-first page (no password field in any frame): fill the username now and
  // hold the password for the next step of this sign-in.
  const step = typeof res.username === "string" && !!res.username && !(await tabHasPassword(tab.id));
  const out = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: fillPage,
    args: [host, { username: res.username, password: step ? "" : res.password, code: res.code }],
  });
  const frames = out.filter((r) => r.result > 0).map((r) => r.frameId);
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
  if (fillsInFlight.has(tabId)) return { error: "busy" };
  fillsInFlight.add(tabId);
  try {
    await dropStep(tabId); // a new fill in this tab replaces any held password
    const account = msg && msg.account !== undefined ? msg.account : undefined;
    const got = await askFill(tabId, info.host, account);
    if (got.error) return { error: got.error };
    if (got.choose) return { choose: got.choose, host: info.host };
    const res = got.cred;
    // The content script says this is a username-only page: the password stays here
    // for the next step instead of going to the page now.
    const step = !!(msg && msg.step === true && typeof res.username === "string" && res.username);
    if (step) await armStep(tabId, info.host, account, res);
    return {
      ok: true, host: info.host, title: str(res.title, 200),
      username: typeof res.username === "string" ? res.username : "",
      password: step ? "" : res.password,
      code: typeof res.code === "string" ? res.code : "",
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
// tab, or a "locked" reply from Notiq. Nothing is ever submitted for the user.
const STEP_TTL = 2 * 60 * 1000;
const stepKey = (tabId) => `step:${tabId}`;

async function armStep(tabId, host, account, res) {
  await chrome.storage.session.set({
    [stepKey(tabId)]: {
      host, account: typeof account === "string" ? account : "", username: res.username, password: res.password, at: Date.now(),
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

// Toolbar path: is a password field showing in any frame of the tab? (Then it is
// not a username-first page.) Each frame answers only true/false.
async function tabHasPassword(tabId) {
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => [...document.querySelectorAll("input[type=password]")].some((i) => {
        const r = i.getBoundingClientRect();
        const cs = getComputedStyle(i);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      }),
    });
    return out.some((r) => r.result === true);
  } catch {
    return true; // can't tell: behave as a normal one-step fill
  }
}

// A content script saw an empty login password field appear. Only the tab that holds
// a password gets it, only while its top page is on the approved site, and only once.
async function onStepFill(_msg, sender) {
  const tabId = sender.tab.id;
  const key = stepKey(tabId);
  const p = (await chrome.storage.session.get(key))[key];
  if (!p) return { none: true };
  const info = topInfo(sender);
  if (info.error || !sameSite(info.host, p.host) || !stepFresh(p, Date.now()) || typeof p.password !== "string") {
    await dropStep(tabId);
    return { none: true };
  }
  if (sender.tab.active === false) return { none: true };
  await dropStep(tabId);
  return { ok: true, host: info.host, username: typeof p.username === "string" ? p.username : "", password: p.password };
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
  if (msg.type === "fill") {
    fillActiveTab(msg.account !== undefined ? msg.account : undefined).then(send, () => send({ error: "failed" }));
    return true;
  }
  if (msg.type === "ping") { ask({ op: "ping" }).then(send); return true; }
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
  chrome.storage.session.remove(pendingKey(tabId));
  dropStep(tabId);
});
