// Unit tests for the password-reuse warning (fillkit.js tag + background reuseSalt / reuseCheck), the per-site
// "Hide Notiq on this site" list, and the toolbar fill's search through open shadow roots (probeFrame / fillPage).
//   node --test browser-extension/test/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac, webcrypto } from "node:crypto";
import vm from "node:vm";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = readFileSync(join(dir, "shared.js"), "utf8");
const FILLKIT = readFileSync(join(dir, "fillkit.js"), "utf8");
const BACKGROUND = readFileSync(join(dir, "background.js"), "utf8");
const plain = (o) => JSON.parse(JSON.stringify(o));

const kctx = vm.createContext({ crypto: webcrypto, Uint32Array, Uint8Array, TextEncoder });
vm.runInContext(FILLKIT, kctx);
const FK = kctx.NotiqFill;
const sctx = vm.createContext({ URL });
vm.runInContext(SHARED, sctx);
const NS = sctx.NotiqShared;

const SALT = "07".repeat(32);
const hmac16 = (saltHex, pw) => createHmac("sha256", Buffer.from(saltHex, "hex")).update(pw, "utf8").digest("hex").slice(0, 32);

// ---------- fillkit.js: the tag sent instead of the password ----------
test("reuseTag is HMAC-SHA256(salt, password) cut to 16 bytes, as the app computes it", async () => {
  for (const pw of ["Pa55word!", "correct horse battery", "pässwörd-ünïcode", "x".repeat(1024)]) {
    assert.equal(await FK.reuseTag(webcrypto.subtle, SALT, pw), hmac16(SALT, pw), pw.slice(0, 20));
  }
  const t = await FK.reuseTag(webcrypto.subtle, SALT, "Pa55word!");
  assert.match(t, /^[0-9a-f]{32}$/);
  assert.notEqual(await FK.reuseTag(webcrypto.subtle, "08".repeat(32), "Pa55word!"), t, "another salt, another tag");
});

test("reuseTag refuses short passwords, bad salts and a missing WebCrypto", async () => {
  assert.equal(await FK.reuseTag(webcrypto.subtle, SALT, "short7!"), null);
  assert.equal(await FK.reuseTag(webcrypto.subtle, SALT, "x".repeat(1025)), null);
  assert.equal(await FK.reuseTag(webcrypto.subtle, "07".repeat(31), "Pa55word!"), null);
  assert.equal(await FK.reuseTag(webcrypto.subtle, "AB".repeat(32), "Pa55word!"), null);
  assert.equal(await FK.reuseTag(null, SALT, "Pa55word!"), null);
  assert.equal(FK.reuseEligible("12345678"), true);
  assert.equal(FK.reuseEligible("1234567"), false);
  assert.equal(FK.reuseEligible("😀😀😀😀😀😀😀"), false, "7 characters (14 UTF-16 units)");
  assert.equal(FK.reuseEligible(12345678), false);
});

// ---------- shared.js: per-site lists ----------
test("hostList keeps valid lower-case hosts, de-duplicated and capped", () => {
  assert.deepEqual(plain(NS.hostList(["Example.COM", "example.com", "a.b-c.io", "", 3, "bad host", "x/y", "é.com", null])),
    ["example.com", "a.b-c.io"]);
  assert.deepEqual(plain(NS.hostList("example.com")), []);
  assert.equal(NS.hostList(Array.from({ length: 600 }, (_, i) => `s${i}.com`)).length, NS.MAX_SITE_LIST);
});

// ---------- background.js ----------
const EXT_ID = "notiq-test-id";
const PAGE = "https://paypa1.com/login";
function event() {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fire: (...a) => fns.map((fn) => fn(...a)) };
}
function area() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      if (typeof keys === "string") return keys in data ? { [keys]: data[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? data[k] : d]));
    },
    async set(o) { Object.assign(data, JSON.parse(JSON.stringify(o))); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
}
const APP = (m) => (m.op === "reuse_salt" ? { ok: true, salt: SALT }
  : m.op === "reuse_check" ? { ok: true, site: "paypal.com" } : { error: "x" });
function boot(reply = APP, { url = PAGE } = {}) {
  const native = [];
  const onMessage = event();
  const tab = { id: 7, url, active: true };
  const updates = [];
  const chrome = {
    runtime: {
      id: EXT_ID, lastError: undefined, onMessage, getManifest: () => ({ version: "0.0.0-test" }),
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      sendNativeMessage: (_h, msg, cb) => { native.push(plain(msg)); queueMicrotask(() => cb(plain(reply(msg)))); },
    },
    storage: { session: area(), local: area() },
    tabs: { onRemoved: event(), onUpdated: event(), query: async () => [tab], sendMessage: () => {},
      update: async (id, props) => { updates.push([id, plain(props)]); } },
    commands: { onCommand: event() },
    scripting: { executeScript: async () => [] },
    action: { openPopup: async () => {} },
  };
  const ctx = vm.createContext({ chrome, setTimeout: () => 0, queueMicrotask, URL, console });
  vm.runInContext(SHARED, ctx);
  vm.runInContext("globalThis.__now = Date.now(); Date.now = () => globalThis.__now;", ctx);
  vm.runInContext(BACKGROUND, ctx);
  const dispatch = (msg, sender) => new Promise((resolve) => {
    const handled = onMessage.fire(msg, sender, (x) => resolve(plain(x)));
    if (!handled.includes(true)) resolve(undefined);
  });
  return {
    ctx, chrome, native, tab, updates,
    vault: () => native.filter((m) => m.op !== "theme" && m.op !== "ping"),
    advance: (ms) => { ctx.__now += ms; },
    page: (type, extra = {}, { frameUrl = tab.url, frameId = 0 } = {}) =>
      dispatch({ type, ...extra }, { id: EXT_ID, url: frameUrl, frameId, tab }),
    popup: (type, extra = {}) => dispatch({ type, ...extra }, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` }),
  };
}
const strip = ({ ext, protocol, ...rest }) => rest;
const TAG = "ab".repeat(16);

test("reuse: salt, then the tag only; the app is told the top host and never a password", async () => {
  const sw = boot();
  assert.deepEqual(await sw.page("reuseSalt"), { ok: true, salt: SALT });
  assert.deepEqual(await sw.page("reuseCheck", { salt: SALT, tag: TAG }), { ok: true, site: "paypal.com" });
  assert.deepEqual(sw.vault().map(strip), [{ op: "reuse_salt" }, { op: "reuse_check", host: "paypa1.com", salt: SALT, tag: TAG }]);
  // The salt is cached: a second check asks the app only once more.
  await sw.page("reuseSalt");
  assert.equal(sw.vault().length, 2);
  sw.advance(11 * 60 * 1000);
  await sw.page("reuseSalt");
  assert.equal(sw.vault().length, 3, "refreshed after 10 minutes");
});

test("reuse: malformed tags or salts never reach the app", async () => {
  const sw = boot();
  for (const bad of [{}, { salt: SALT }, { salt: SALT, tag: "ab".repeat(32) }, { salt: SALT, tag: "AB".repeat(16) },
    { salt: "07", tag: TAG }, { salt: SALT, tag: 5 }, { salt: SALT, tag: TAG.slice(1) }]) {
    assert.deepEqual(await sw.page("reuseCheck", bad), { error: "bad_request" }, JSON.stringify(bad));
  }
  assert.equal(sw.vault().length, 0);
});

test("reuse: the page's own site, a bad host or nothing from the app means no warning", async () => {
  for (const site of ["paypa1.com", "www.paypa1.com", "PAYPA1.COM", "a b", "x".repeat(254), 5, null, "<b>x</b>"]) {
    const sw = boot((m) => (m.op === "reuse_check" ? { ok: true, site } : APP(m)));
    assert.deepEqual(await sw.page("reuseCheck", { salt: SALT, tag: TAG }), { ok: true, site: null }, String(site).slice(0, 20));
  }
  for (const error of ["locked", "rate_limited", "unknown_op", "app_not_running"]) {
    const sw = boot((m) => ({ error }));
    assert.equal((await sw.page("reuseSalt")).ok, undefined);
    assert.equal((await sw.page("reuseCheck", { salt: SALT, tag: TAG })).error, error);
  }
});

test("reuse: a stale salt (Notiq restarted) is dropped and fetched again", async () => {
  let salt = SALT;
  const sw = boot((m) => (m.op === "reuse_salt" ? { ok: true, salt } : m.salt === salt ? { ok: true, site: "paypal.com" } : { error: "stale_salt" }));
  await sw.page("reuseSalt");
  salt = "09".repeat(32);
  assert.deepEqual(await sw.page("reuseCheck", { salt: SALT, tag: TAG }), { error: "stale_salt" });
  assert.deepEqual(await sw.page("reuseSalt"), { ok: true, salt });
  assert.deepEqual(await sw.page("reuseCheck", { salt, tag: TAG }), { ok: true, site: "paypal.com" });
});

test("reuse: 'I trust this site' stores the top host; no salt or check is asked there afterwards", async () => {
  const sw = boot();
  assert.deepEqual(await sw.page("reuseTrust", { host: "evil.example" }), { ok: true, host: "paypa1.com", listed: true });
  assert.deepEqual(sw.chrome.storage.local.data.reuseTrusted, ["paypa1.com"], "the host comes from the tab, not the message");
  assert.deepEqual(await sw.page("reuseSalt"), { error: "trusted" });
  assert.deepEqual(await sw.page("reuseCheck", { salt: SALT, tag: TAG }), { ok: true, site: null });
  assert.equal(sw.vault().length, 0);
  await sw.page("reuseTrust");
  assert.deepEqual(sw.chrome.storage.local.data.reuseTrusted, ["paypa1.com"], "no duplicates");
});

test("reuse: 'Leave this site' navigates the tab away", async () => {
  const sw = boot();
  assert.deepEqual(await sw.page("reuseLeave"), { ok: true });
  assert.deepEqual(sw.updates, [[7, { url: "about:blank" }]]);
});

test("reuse: same-site frames may ask (for the top host), other sites' frames may not", async () => {
  const sw = boot(APP, { url: "https://www.example.com/" });
  assert.deepEqual(await sw.page("reuseSalt", {}, { frameUrl: "https://login.example.com/f", frameId: 3 }), { ok: true, salt: SALT });
  await sw.page("reuseCheck", { salt: SALT, tag: TAG }, { frameUrl: "https://login.example.com/f", frameId: 3 });
  assert.equal(sw.vault().at(-1).host, "www.example.com");
  const n = sw.vault().length;
  for (const type of ["reuseSalt", "reuseCheck", "reuseTrust", "reuseLeave", "hideSite"]) {
    assert.equal(await sw.page(type, { salt: SALT, tag: TAG }, { frameUrl: "https://evil.org/f", frameId: 4 }), undefined, type);
  }
  assert.equal(sw.vault().length, n);
  assert.deepEqual(sw.updates, []);
});

test("reuse: insecure pages get nothing", async () => {
  const sw = boot(APP, { url: "http://paypa1.com/login" });
  assert.deepEqual(await sw.page("reuseSalt"), { error: "not_https" });
  assert.deepEqual(await sw.page("reuseCheck", { salt: SALT, tag: TAG }), { error: "not_https" });
  assert.equal(sw.vault().length, 0);
});

test("hide on this site: from the page (top host from the tab) and from the popup, with undo", async () => {
  const sw = boot(APP, { url: "https://accounts.example.com/signin" });
  assert.deepEqual(await sw.popup("siteHidden"), { ok: true, host: "accounts.example.com", hidden: false });
  assert.deepEqual(await sw.page("hideSite", { host: "other.org" }), { ok: true, host: "accounts.example.com", listed: true });
  assert.deepEqual(sw.chrome.storage.local.data.hiddenSites, ["accounts.example.com"]);
  assert.deepEqual(await sw.popup("siteHidden"), { ok: true, host: "accounts.example.com", hidden: true });
  assert.deepEqual(await sw.popup("setSiteHidden", { hidden: false }), { ok: true, host: "accounts.example.com", hidden: false });
  assert.deepEqual(sw.chrome.storage.local.data.hiddenSites, []);
  assert.deepEqual(await sw.popup("setSiteHidden", { hidden: "yes" }), { error: "bad_request" });
  assert.deepEqual(await sw.popup("setSiteHidden", { hidden: true }), { ok: true, host: "accounts.example.com", hidden: true });
  // A content script can't use the popup's messages, and the popup's don't exist for pages.
  assert.equal(await sw.page("setSiteHidden", { hidden: false }), undefined);
  assert.equal(await sw.page("siteHidden"), undefined);
  assert.equal(await sw.popup("hideSite"), undefined);
  assert.equal(sw.vault().length, 0, "none of this asks Notiq");
});

test("hide on this site: no tab host on non-https pages", async () => {
  const sw = boot(APP, { url: "chrome://extensions/" });
  assert.equal((await sw.popup("siteHidden")).error, "not_https");
  assert.equal((await sw.popup("setSiteHidden", { hidden: true })).error, "not_https");
});

// ---------- toolbar fill through open shadow roots (probeFrame / fillPage on a tiny fake DOM) ----------
class FakeInput {
  constructor(attrs = {}) {
    Object.assign(this, { tagName: "INPUT", type: "text", name: "", id: "", placeholder: "", autocomplete: "", maxLength: -1,
      inputMode: "", disabled: false, readOnly: false, form: null, kids: [], shadowRoot: null, events: [] }, attrs);
    this._v = "";
  }
  get value() { return this._v; }
  set value(v) { this._v = v; }
  matches(sel) { return sel.split(",").map((s) => s.trim().toUpperCase()).includes(this.tagName); }
  querySelectorAll() { return descendants(this); }
  getBoundingClientRect() { return { width: 200, height: 30 }; }
  focus() {}
  dispatchEvent(e) { this.events.push(e.type); return true; }
  getAttribute(n) { return this[n] ?? null; }
}
function box(tag, kids = [], shadowKids = null) {
  const n = new FakeInput({ tagName: tag, kids });
  if (shadowKids) n.shadowRoot = { kids: shadowKids, host: n, querySelectorAll: () => descendants(n.shadowRoot) };
  return n;
}
function descendants(n) {
  const out = [];
  const walk = (x) => { for (const k of x.kids) { out.push(k); walk(k); } };
  walk(n);
  return out;
}
function frameCtx(doc, origin = "https://accounts.example.com") {
  const win = {};
  win.top = win;
  return vm.createContext({
    window: win, document: doc, location: { origin, hostname: new URL(origin).hostname, ancestorOrigins: [] },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    Event: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type) { this.type = type; } },
    InputEvent: class { constructor(type) { this.type = type; } },
  });
}

test("toolbar fill: the probe and the fill find a login inside nested open shadow roots", () => {
  const sw = boot();
  const user = new FakeInput({ type: "email", name: "email" });
  const pass = new FakeInput({ type: "password", name: "password" });
  // <login-form> # shadow: <x-field> # shadow: <input email>, <x-field> # shadow: <input password>
  const doc = box("DOC", [box("LOGIN-FORM", [], [box("X-FIELD", [], [user]), box("X-FIELD", [], [pass])])]);
  const ctx = frameCtx(doc);
  const probe = vm.runInContext(`(${sw.ctx.probeFrame.toString()})`, ctx)();
  assert.equal(probe.fields, true);
  assert.equal(probe.password, true);
  const n = vm.runInContext(`(${sw.ctx.fillPage.toString()})`, ctx)("accounts.example.com",
    { username: "alice@example.com", password: "S3cret-pass" }, { top: "https://accounts.example.com", allowed: ["https://accounts.example.com"] });
  assert.equal(n, 2);
  assert.equal(user.value, "alice@example.com");
  assert.equal(pass.value, "S3cret-pass");
  assert.ok(pass.events.includes("input") && pass.events.includes("change"));
});

test("toolbar fill: closed roots stay closed, and the walk is bounded", () => {
  const sw = boot();
  const closed = box("X-CLOSED"); // a closed root holding a password field: shadowRoot is null from outside
  let probe = vm.runInContext(`(${sw.ctx.probeFrame.toString()})`, frameCtx(box("DOC", [closed])))();
  assert.equal(probe.fields, false);
  // Deeper than 6 nested roots: not searched.
  let inner = new FakeInput({ type: "password" });
  let host = box("X-0", [], [inner]);
  for (let i = 1; i <= 7; i++) host = box(`X-${i}`, [], [host]);
  probe = vm.runInContext(`(${sw.ctx.probeFrame.toString()})`, frameCtx(box("DOC", [host])))();
  assert.equal(probe.password, false);
  // At depth 6 it is found.
  inner = new FakeInput({ type: "password" });
  host = box("X-0", [], [inner]);
  for (let i = 1; i <= 5; i++) host = box(`X-${i}`, [], [host]);
  probe = vm.runInContext(`(${sw.ctx.probeFrame.toString()})`, frameCtx(box("DOC", [host])))();
  assert.equal(probe.password, true);
});

test("toolbar fill: with fillkit.js in the frame, its deepQuery is used (the in-page icon's search)", () => {
  const sw = boot();
  const pass = new FakeInput({ type: "password" });
  const doc = box("DOC", [box("X-FIELD", [], [pass])]);
  const ctx = frameCtx(doc);
  let used = 0;
  ctx.NotiqFill = { deepQuery: (root, sel) => { used++; return kctx.NotiqFill.deepQuery(root, sel); } };
  const probe = vm.runInContext(`(${sw.ctx.probeFrame.toString()})`, ctx)();
  assert.equal(probe.password, true);
  assert.ok(used > 0);
});
