// Notiq Autofill — service worker. Talks to the Notiq app through the native host.
const HOST = "com.trexolab.notiq";
const PENDING_TTL = 90 * 1000;
const MAX = { host: 253, url: 2048, title: 80, username: 512, password: 1024, message: 8192, neverSave: 500 };
const SETTINGS_DEFAULTS = { offerSave: true, showIcon: true, neverSave: [] };

function ask(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, msg, (res) => {
      if (chrome.runtime.lastError) resolve({ error: "no_host", detail: chrome.runtime.lastError.message });
      else resolve(res || { error: "no_reply" });
    });
  });
}

// Runs inside the page. `host` must equal the frame's own host, so credentials
// are never typed into a different site's iframe.
function fillPage(host, cred) {
  if (location.hostname.toLowerCase() !== host) return 0;
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
  const otp = all.find((i) => textual(i) && (i.autocomplete === "one-time-code" ||
    /otp|totp|2fa|mfa|verification|security.?code|one.?time/i.test(`${i.name} ${i.id} ${i.placeholder}`)));
  if (pw) {
    const form = pw.form || document;
    const candidates = [...form.querySelectorAll("input")].filter((i) => visible(i) && textual(i) && i !== otp);
    const before = candidates.filter((i) => pw.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING);
    const user = before.length ? before[before.length - 1] : null;
    if (user && cred.username) { set(user, cred.username); n++; }
    set(pw, cred.password); n++;
  } else if (!otp) {
    // Username-first flows: fill the only visible text/email field.
    const user = all.find((i) => textual(i) && /user|email|login|account/i.test(`${i.name} ${i.id} ${i.autocomplete} ${i.type}`)) || all.find(textual);
    if (user && cred.username) { set(user, cred.username); n++; }
  }
  if (otp && cred.code) { set(otp, cred.code); n++; }
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
function notifyFilled(tabId, host, res) {
  try {
    chrome.tabs.sendMessage(tabId, {
      type: "filled", host,
      username: typeof res.username === "string" ? res.username : "",
      password: typeof res.password === "string" ? res.password : "",
    }, { frameId: 0 }, () => void chrome.runtime.lastError);
  } catch { /* no content script on this page */ }
}

async function fillActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return { error: "no_tab" };
  let u;
  try { u = new URL(tab.url); } catch { return { error: "bad_url" }; }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return { error: "not_https" };
  const host = u.hostname.toLowerCase();
  const res = await ask({ op: "fill", host });
  if (res.error) return res;
  const out = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: fillPage,
    args: [host, { username: res.username, password: res.password, code: res.code }],
  });
  const filled = out.reduce((a, r) => a + (r.result || 0), 0);
  if (filled) notifyFilled(tab.id, host, res);
  return filled ? { ok: true, host, title: res.title } : { error: "no_fields" };
}

// ---------- requests from the in-page content script (top frame only) ----------
const fillsInFlight = new Set();
const savesInFlight = new Set();
const pendingKey = (tabId) => `pending:${tabId}`;

// The in-page icon was clicked (a trusted click, checked in content.js). The
// host comes from the sender's own URL, never from the message. Credentials go
// back only to the content script that asked, which fills its own page.
async function fillForSender(sender) {
  const info = pageInfo(sender.url);
  if (info.error) return { error: info.error };
  if (sender.tab.active === false) return { error: "denied" };
  const tabId = sender.tab.id;
  if (fillsInFlight.has(tabId)) return { error: "busy" };
  fillsInFlight.add(tabId);
  try {
    const res = await ask({ op: "fill", host: info.host });
    if (res.error) return { error: String(res.error).slice(0, 40) };
    if (typeof res.password !== "string") return { error: "no_reply" };
    return {
      ok: true, host: info.host, title: str(res.title, 200),
      username: typeof res.username === "string" ? res.username : "",
      password: res.password,
      code: typeof res.code === "string" ? res.code : "",
    };
  } finally {
    fillsInFlight.delete(tabId);
  }
}

async function getSettings() {
  const s = await chrome.storage.local.get(SETTINGS_DEFAULTS);
  return {
    offerSave: s.offerSave !== false,
    showIcon: s.showIcon !== false,
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
  if (Object.keys(p).some((k) => !CAPTURE_KEYS.includes(k))) return { error: "bad_request" };
  if (!CAPTURE_KEYS.every((k) => typeof p[k] === "string")) return { error: "bad_request" };
  if (!p.password || p.password.length > MAX.password || p.username.length > MAX.username) return { error: "bad_request" };
  const info = pageInfo(sender.url);
  if (info.error) return { error: info.error };
  // The payload's host must be the sender page's own host.
  if (p.host.toLowerCase() !== info.host) return { error: "bad_request" };
  const settings = await getSettings();
  if (!settings.offerSave || settings.neverSave.includes(info.host)) return { ok: false, skipped: true };
  // SPAs change the path without the sender URL following; accept the page's
  // url only when it is on the same origin, else use the sender's.
  let url = info.url;
  const claimed = pageInfo(p.url);
  if (!claimed.error && claimed.origin === info.origin) url = claimed.url;
  await purgeExpired();
  await chrome.storage.session.set({
    [pendingKey(sender.tab.id)]: {
      host: info.host, url, username: str(p.username, MAX.username), password: p.password,
      title: str(p.title, MAX.title), at: Date.now(),
    },
  });
  return { ok: true };
}

async function onPending(_msg, sender) {
  const p = await readPending(sender.tab.id);
  // Never hand the password back to the page side.
  return { pending: p ? { host: p.host, username: p.username } : null };
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

const CONTENT_HANDLERS = {
  fill: (_m, s) => fillForSender(s),
  capture: onCapture,
  pending: onPending,
  save: onSave,
  dismiss: onDismiss,
  never: onNever,
};

function messageTooBig(msg) {
  try { return JSON.stringify(msg).length > MAX.message; } catch { return true; }
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  // Only this extension's own popup and content scripts.
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string" || messageTooBig(msg)) return false;

  if (sender.tab) {
    // Content script: top frame of a real tab only.
    if (sender.frameId !== 0 || typeof sender.tab.id !== "number" || sender.tab.id < 0 || typeof sender.url !== "string") return false;
    const handler = Object.prototype.hasOwnProperty.call(CONTENT_HANDLERS, msg.type) ? CONTENT_HANDLERS[msg.type] : null;
    if (!handler) return false;
    handler(msg, sender).then(send, () => send({ error: "failed" }));
    return true;
  }

  // Extension pages (the popup).
  if (typeof sender.url === "string" && !sender.url.startsWith(chrome.runtime.getURL(""))) return false;
  if (msg.type === "fill") { fillActiveTab().then(send); return true; }
  if (msg.type === "ping") { ask({ op: "ping" }).then(send); return true; }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(pendingKey(tabId));
});
