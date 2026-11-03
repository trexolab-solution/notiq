// Unit tests for private (incognito) windows and the Save / Update / nothing decision of the save offer
// (background.js `save_check`, shared.js helpers, content.js start-up gate).
//   node --test browser-extension/test/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = readFileSync(join(dir, "shared.js"), "utf8");
const PASSKEYS = readFileSync(join(dir, "passkeys.js"), "utf8");
const BACKGROUND = readFileSync(join(dir, "background.js"), "utf8");
const CONTENT = readFileSync(join(dir, "content.js"), "utf8");
const EXT_ID = "notiq-test-id";
const PAGE = "https://accounts.example.com/signin";
const plain = (o) => (o === undefined ? o : JSON.parse(JSON.stringify(o)));
const strip = ({ ext, protocol, ...rest }) => rest;
const CRED = { ok: true, username: "alice@example.com", password: "Secret-1!", title: "Example" };
const PING = { ok: true, appVersion: "0.9.3", locked: false, protocol: 2, minProtocol: 1 };

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

// A fresh service worker whose active tab is `tab`. `reply(msg)` answers native messages.
function boot(reply = (m) => (m.op === "fill" ? CRED : m.op === "ping" ? PING : { error: "app_not_running" }),
  { incognito = false, url = PAGE } = {}) {
  const native = [];
  const tabMsgs = [];
  const onMessage = event();
  const tab = { id: 7, url, active: true, incognito };
  const menuClicked = event();
  const chrome = {
    runtime: {
      id: EXT_ID, lastError: undefined, onMessage, getManifest: () => ({ version: "0.0.0-test" }),
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      sendNativeMessage: (_h, msg, cb) => { native.push(plain(msg)); queueMicrotask(() => cb(plain(reply(msg)))); },
    },
    storage: { session: area(), local: area(), onChanged: event() },
    tabs: {
      onRemoved: event(), onUpdated: event(), query: async () => [tab],
      sendMessage: (...a) => { tabMsgs.push(plain(a.slice(0, 3).filter((x) => typeof x !== "function"))); },
    },
    commands: { onCommand: event() },
    contextMenus: { create: (_p, cb) => cb && cb(), remove: (_id, cb) => cb && cb(), removeAll: (cb) => cb && cb(), onClicked: menuClicked },
    scripting: {
      executeScript: async (o) => {
        if (o.func && o.func.name === "probeFrame") return [{ frameId: 0, result: { origin: new URL(tab.url).origin, top: true, ancestors: [], fields: true, password: true } }];
        return [{ frameId: 0, result: 2 }];
      },
    },
    action: { openPopup: async () => {} },
  };
  const ctx = vm.createContext({ chrome, setTimeout: () => 0, queueMicrotask, URL, console, TextEncoder, crypto: globalThis.crypto });
  vm.runInContext(SHARED, ctx);
  vm.runInContext(PASSKEYS, ctx);
  vm.runInContext(BACKGROUND, ctx);
  const fire = (msg, sender) => new Promise((resolve) => {
    const r = onMessage.fire(msg, sender, (x) => resolve(plain(x)));
    if (!r.includes(true)) resolve(undefined);
  });
  return {
    chrome, native, tab, tabMsgs, menuClicked,
    vault: () => native.filter((m) => m.op !== "theme" && m.op !== "ping"),
    page: (type, extra = {}) => fire({ type, ...extra }, { id: EXT_ID, url: tab.url, frameId: 0, tab, origin: new URL(tab.url).origin }),
    popup: (type, extra = {}) => fire({ type, ...extra }, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` }),
    session: () => chrome.storage.session.data,
    local: () => chrome.storage.local.data,
  };
}
const settle = () => new Promise((r) => setTimeout(r, 5));
const CAPTURE = { host: "accounts.example.com", url: PAGE, username: "alice@example.com", password: "New-Secret-2!", title: "Sign in" };

// ---------- shared.js helpers ----------
const sctx = vm.createContext({ URL });
vm.runInContext(SHARED, sctx);
const NS = sctx.NotiqShared;

test("shared: ping's incognito field, the block rule and the save_check answer", () => {
  assert.equal(NS.pingIncognito({ ok: true, incognito: true }), true);
  assert.equal(NS.pingIncognito({ ok: true, incognito: false }), false);
  assert.equal(NS.pingIncognito({ ok: true }), undefined, "older app: says nothing");
  assert.equal(NS.pingIncognito({ ok: true, incognito: "true" }), undefined);
  assert.equal(NS.pingIncognito({ error: "app_not_running", incognito: true }), undefined);
  assert.equal(NS.incognitoBlocked(true, false), true);
  assert.equal(NS.incognitoBlocked(true, undefined), true, "off unless explicitly allowed");
  assert.equal(NS.incognitoBlocked(true, true), false);
  assert.equal(NS.incognitoBlocked(false, false), false);
  for (const a of ["none", "update", "save"]) assert.equal(NS.saveCheckAction({ ok: true, action: a }), a);
  for (const r of [{ ok: true, action: "delete" }, { error: "locked" }, { error: "unknown_op" }, null, { action: "none" }]) {
    assert.equal(NS.saveCheckAction(r), null, JSON.stringify(r));
  }
  assert.equal(NS.offerKind("update", false), "update");
  assert.equal(NS.offerKind("save", true), "save", "the app's answer wins over the form's shape");
  assert.equal(NS.offerKind(null, true), "update");
  assert.equal(NS.offerKind(null, false), "save");
  assert.match(NS.INCOGNITO_TEXT, /Settings → Vault → Browser autofill/);
});

// ---------- private windows (setting off by default) ----------
test("private tab, setting off: every page request is refused and Notiq is never asked", async () => {
  const sw = boot(undefined, { incognito: true });
  assert.deepEqual(await sw.page("fill"), { error: "incognito_off" });
  assert.deepEqual(await sw.page("fillCard"), { error: "incognito_off" });
  assert.deepEqual(await sw.page("capture", { payload: CAPTURE }), { error: "incognito_off" });
  assert.deepEqual(await sw.page("pending"), { error: "incognito_off" });
  assert.deepEqual(await sw.page("save"), { error: "incognito_off" });
  assert.deepEqual(await sw.page("stepFill"), { error: "incognito_off" });
  assert.deepEqual(await sw.page("fillIdentity"), { error: "incognito_off" });
  assert.deepEqual(await sw.page("reuseSalt"), { error: "incognito_off" });
  assert.deepEqual(await sw.page("hideSite"), { error: "incognito_off" });
  assert.deepEqual(sw.vault(), [], "nothing reached the native host");
  assert.equal(Object.keys(sw.session()).some((k) => k.startsWith("pending:")), false, "no login was held for a save offer");
});

test("private tab, setting off: toolbar fill, popup list and the private-state notice", async () => {
  const sw = boot(undefined, { incognito: true });
  assert.deepEqual(await sw.popup("fill"), { error: "incognito_off" });
  assert.deepEqual(await sw.popup("list"), { error: "incognito_off" });
  assert.deepEqual(await sw.popup("copy", { account: "a.nqv", what: "password" }), { error: "incognito_off" });
  assert.deepEqual(await sw.popup("privateState"), { ok: true, blocked: true });
  assert.deepEqual(sw.vault(), []);
  const normal = boot();
  assert.deepEqual(await normal.popup("privateState"), { ok: true, blocked: false });
});

test("private tab, setting off: passkeys fall back to the browser, the menu and Alt+Shift+L do nothing", async () => {
  const sw = boot(undefined, { incognito: true });
  await sw.chrome.storage.local.set({ passkeys: true });
  const r = await sw.page("passkey", { kind: "get", options: { challenge: "AAAA", rpId: "example.com" }, ancestors: [] });
  assert.deepEqual(r, { fallback: true });
  sw.menuClicked.fire({ menuItemId: "nq-login", frameId: 0, pageUrl: PAGE }, sw.tab);
  sw.chrome.commands.onCommand.fire("fill-login", sw.tab);
  await settle();
  assert.deepEqual(sw.tabMsgs, [], "no menuFill / fillShortcut was sent to the page");
  assert.deepEqual(sw.vault(), []);
});

test("the app's ping turns private-window autofill on; requests then carry incognito:true", async () => {
  const sw = boot((m) => (m.op === "ping" ? { ...PING, incognito: true } : m.op === "fill" ? CRED : { error: "x" }), { incognito: true });
  await sw.popup("ping");
  assert.equal(sw.local().incognitoAllowed, true);
  assert.deepEqual(await sw.popup("privateState"), { ok: true, blocked: false });
  const r = await sw.page("fill");
  assert.equal(r.ok, true);
  const [fill] = sw.vault();
  assert.equal(fill.op, "fill");
  assert.equal(fill.incognito, true, "the app can enforce the setting itself");
});

test("an incognito_off answer from the app turns the cached setting off again", async () => {
  let allow = true;
  const sw = boot((m) => (m.op === "ping" ? { ...PING, incognito: allow } : m.op === "fill" ? (allow ? CRED : { error: "incognito_off" }) : { error: "x" }), { incognito: true });
  await sw.popup("ping");
  assert.equal(sw.local().incognitoAllowed, true);
  allow = false; // turned off in Notiq; the extension has not pinged since
  assert.deepEqual(await sw.page("fill"), { error: "incognito_off" });
  assert.equal(sw.local().incognitoAllowed, false);
  assert.deepEqual(await sw.page("fill"), { error: "incognito_off" });
  assert.equal(sw.vault().length, 1, "the second fill never reached Notiq");
});

test("a normal tab: requests carry no incognito flag and the setting does not matter", async () => {
  const sw = boot();
  assert.equal((await sw.page("fill")).ok, true);
  assert.deepEqual(strip(sw.vault()[0]), { op: "fill", host: "accounts.example.com" });
});

// ---------- save offer: Save, Update or nothing ----------
function saveSw(action, extra = {}) {
  const asked = [];
  const sw = boot((m) => {
    if (m.op === "save_check") { asked.push(m); return typeof action === "function" ? action(m) : action; }
    if (m.op === "save") return { ok: true, status: "updated" };
    return m.op === "ping" ? PING : { error: "x" };
  }, extra);
  sw.asked = asked;
  return sw;
}

test("save_check 'none': the exact login is already saved, so no offer at all", async () => {
  const sw = saveSw({ ok: true, action: "none", choices: 0 });
  assert.deepEqual(await sw.page("capture", { payload: CAPTURE }), { ok: true });
  assert.deepEqual(await sw.page("pending"), { pending: null });
  assert.equal(Object.keys(sw.session()).some((k) => k.startsWith("pending:")), false, "the held login is dropped");
  assert.equal(sw.asked.length, 1);
  assert.deepEqual(strip(sw.asked[0]), { op: "save_check", host: "accounts.example.com", username: "alice@example.com", password: "New-Secret-2!" });
});

test("save_check 'update': the card says Update; Notiq is asked once per captured login", async () => {
  const sw = saveSw({ ok: true, action: "update", choices: 2 });
  await sw.page("capture", { payload: CAPTURE });
  const r = await sw.page("pending");
  assert.deepEqual(r, { pending: { host: "accounts.example.com", username: "alice@example.com", change: false, kind: "update" } });
  assert.equal(JSON.stringify(r).includes("New-Secret"), false, "the password never goes back to the page");
  await sw.page("pending");
  assert.equal(sw.asked.length, 1, "the answer is kept with the pending login");
  assert.deepEqual(await sw.page("save"), { ok: true, status: "updated" });
});

test("save_check 'save': a new username gets the Save card", async () => {
  const sw = saveSw({ ok: true, action: "save", choices: 0 });
  await sw.page("capture", { payload: { ...CAPTURE, change: true } });
  assert.equal((await sw.page("pending")).pending.kind, "save");
});

test("locked vault / older app: the old offer (wording from the form), Notiq decides on Save", async () => {
  for (const reply of [{ error: "locked" }, { error: "unknown_op" }, { error: "app_not_running" }]) {
    const sw = saveSw(reply);
    await sw.page("capture", { payload: { ...CAPTURE, change: true } });
    assert.equal((await sw.page("pending")).pending.kind, "update", reply.error);
    const sw2 = saveSw(reply);
    await sw2.page("capture", { payload: CAPTURE });
    assert.equal((await sw2.page("pending")).pending.kind, "save", reply.error);
  }
});

test("change-password form: the current password goes to Notiq (check and save), never back to the page", async () => {
  const sw = saveSw({ ok: true, action: "update", choices: 1 });
  await sw.page("capture", { payload: { ...CAPTURE, username: "", change: true, current: "Old-Secret-1!" } });
  const r = await sw.page("pending");
  assert.equal(r.pending.kind, "update");
  assert.equal(JSON.stringify(r).includes("Old-Secret"), false);
  assert.equal(sw.asked[0].current, "Old-Secret-1!");
  await sw.page("save");
  const save = sw.vault().find((m) => m.op === "save");
  assert.equal(save.current, "Old-Secret-1!");
  assert.equal(save.password, "New-Secret-2!");
});

test("capture rejects a malformed current password; a current equal to the new one is dropped", async () => {
  const sw = saveSw({ ok: true, action: "save" });
  assert.deepEqual(await sw.page("capture", { payload: { ...CAPTURE, current: 5 } }), { error: "bad_request" });
  assert.deepEqual(await sw.page("capture", { payload: { ...CAPTURE, current: "x".repeat(1025) } }), { error: "bad_request" });
  assert.deepEqual(await sw.page("capture", { payload: { ...CAPTURE, current: CAPTURE.password } }), { ok: true });
  const p = Object.entries(sw.session()).find(([k]) => k.startsWith("pending:"))[1];
  assert.equal("current" in p, false);
});

test("'Never for this site' still wins: no capture, no save_check", async () => {
  const sw = saveSw({ ok: true, action: "save" });
  await sw.chrome.storage.local.set({ neverSave: ["accounts.example.com"] });
  assert.deepEqual(await sw.page("capture", { payload: CAPTURE }), { ok: false, skipped: true });
  assert.deepEqual(await sw.page("pending"), { pending: null });
  assert.equal(sw.asked.length, 0);
});

test("a newer capture during the check keeps its own offer", async () => {
  // The first login is already saved; the second is not.
  const sw = saveSw((m) => ({ ok: true, action: m.password === CAPTURE.password ? "none" : "save" }));
  await sw.page("capture", { payload: CAPTURE });
  // Replace the pending login while the first check is on its way.
  const pend = sw.page("pending");
  assert.deepEqual(await sw.page("capture", { payload: { ...CAPTURE, password: "Other-3!" } }), { ok: true });
  assert.deepEqual(await pend, { pending: null }, "the first login was already saved");
  const left = Object.entries(sw.session()).filter(([k]) => k.startsWith("pending:"));
  assert.equal(left.length, 1, "the newer login is still pending");
  assert.equal(left[0][1].password, "Other-3!");
});

test("private tab with autofill allowed: the save check and the save carry incognito:true", async () => {
  const sw = saveSw({ ok: true, action: "update" }, { incognito: true });
  await sw.chrome.storage.local.set({ incognitoAllowed: true });
  await sw.page("capture", { payload: CAPTURE });
  await sw.page("pending");
  await sw.page("save");
  assert.equal(sw.asked[0].incognito, true);
  assert.equal(sw.vault().find((m) => m.op === "save").incognito, true);
});

// ---------- content.js: inert in private windows until allowed ----------
function runContent({ incognito, allowed }) {
  let touched = 0;
  const local = area();
  if (allowed !== undefined) local.data.incognitoAllowed = allowed;
  const changed = event();
  const chrome = {
    extension: { inIncognitoContext: incognito },
    runtime: { id: EXT_ID, onMessage: event(), sendMessage: () => {} },
    storage: {
      local: { get: (d, cb) => { local.get(d).then(cb); }, set: local.set },
      onChanged: changed,
    },
  };
  // Any start of main() reads `location` (then quits: a plain-http page); count that.
  const location = new Proxy({ protocol: "http:", hostname: "example.com" }, { get: (t, k) => { touched++; return t[k]; } });
  const ctx = vm.createContext({ chrome, location, URL });
  vm.runInContext(SHARED, ctx);
  ctx.NotiqFill = {};
  vm.runInContext(CONTENT, ctx);
  return { touched: () => touched, changed };
}

test("content script: does nothing in a private window until the setting is on", async () => {
  const normal = runContent({ incognito: false });
  assert.ok(normal.touched() > 0, "a normal window starts at once");
  const off = runContent({ incognito: true });
  await settle();
  assert.equal(off.touched(), 0, "a private window with the setting off never starts");
  off.changed.fire({ incognitoAllowed: { newValue: false } }, "local");
  assert.equal(off.touched(), 0);
  off.changed.fire({ incognitoAllowed: { newValue: true } }, "local");
  assert.ok(off.touched() > 0, "turned on later: starts then");
  const on = runContent({ incognito: true, allowed: true });
  await settle();
  assert.ok(on.touched() > 0, "allowed: starts");
});
