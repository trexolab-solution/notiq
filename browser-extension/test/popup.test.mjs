// Unit tests for the toolbar popup's site logins list (0.9.0): popupkit.js (pure helpers) and the background's
// popup handlers (list / popupFill / copy / open) in a vm with a small chrome.* mock.
//   node --test browser-extension/test/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = readFileSync(join(dir, "shared.js"), "utf8");
const BACKGROUND = readFileSync(join(dir, "background.js"), "utf8");
const KIT = readFileSync(join(dir, "popupkit.js"), "utf8");
const plain = (o) => JSON.parse(JSON.stringify(o));

const kitCtx = vm.createContext({});
vm.runInContext(KIT, kitCtx);
const NP = kitCtx.NotiqPopup;

const A = [
  { account: "Logins/Work.nqv", title: "Work", username: "alice@work.com", totp: true },
  { account: "Logins/Home.nqv", title: "Home", username: "alice@home.example", totp: false },
  { account: "Logins/Bare.nqv", title: "", username: "", totp: false },
];

// ---------- popupkit.js ----------
test("popupkit: frozen, non-writable global", () => {
  assert.ok(NP && Object.isFrozen(NP));
  assert.equal(Reflect.set(kitCtx, "NotiqPopup", null), false);
  vm.runInContext(KIT, kitCtx); // loading twice is harmless
  assert.equal(kitCtx.NotiqPopup, NP);
});

test("popupkit: validAccounts keeps names only and rejects malformed lists", () => {
  const ok = plain(NP.validAccounts([{ ...A[0], password: "S3cret", title: "Work\u0007" }, A[1]]));
  assert.deepEqual(ok, [A[0], A[1]]);
  assert.ok(!JSON.stringify(ok).includes("S3cret"));
  assert.deepEqual(plain(NP.validAccounts([])), []);
  assert.deepEqual(plain(NP.validAccounts([A[0], A[0]])), [A[0]]); // duplicates dropped
  assert.equal(plain(NP.validAccounts([{ ...A[1], totp: "yes" }]))[0].totp, false);
  for (const bad of [null, "x", {}, [null], [{ account: "", title: "", username: "" }], [{ account: 1, title: "", username: "" }],
    [{ account: "a", title: "t".repeat(201), username: "" }], [{ account: "a".repeat(257), title: "", username: "" }],
    Array.from({ length: 51 }, (_, i) => ({ account: `a${i}`, title: "", username: "" }))]) {
    assert.equal(NP.validAccounts(bad), null, JSON.stringify(bad).slice(0, 60));
  }
});

test("popupkit: filter matches title and username, every word, case-insensitive", () => {
  const titles = (q) => NP.filterAccounts(A, q).map((a) => a.account);
  assert.deepEqual(titles(""), A.map((a) => a.account));
  assert.deepEqual(titles("   "), A.map((a) => a.account));
  assert.deepEqual(titles("WORK"), ["Logins/Work.nqv"]);
  assert.deepEqual(titles("alice"), ["Logins/Work.nqv", "Logins/Home.nqv"]);
  assert.deepEqual(titles("alice home"), ["Logins/Home.nqv"]);
  assert.deepEqual(titles("example work"), []);
  assert.deepEqual(titles(null), A.map((a) => a.account));
});

test("popupkit: row text and accessible names", () => {
  assert.deepEqual(plain(NP.rowText(A[0])), { title: "Work", sub: "alice@work.com" });
  assert.deepEqual(plain(NP.rowText({ ...A[0], title: "" })), { title: "alice@work.com", sub: "" });
  assert.deepEqual(plain(NP.rowText(A[2])), { title: "Login", sub: "" });
  assert.deepEqual(plain(NP.rowText({ ...A[0], username: "" })), { title: "Work", sub: "no username" });
  const l = NP.labels(A[0]);
  assert.equal(l.fill, "Fill Work (alice@work.com)");
  assert.equal(l.password, "Copy password of Work");
  assert.equal(l.code, "Copy 2FA code of Work");
  assert.equal(l.open, "Open Work in Notiq");
  assert.equal(NP.labels(A[1]).code, "No 2FA code saved for Home");
});

test("popupkit: messages", () => {
  assert.equal(NP.copiedText("password", 30), "Password copied by Notiq. Clears in 30 s.");
  assert.equal(NP.copiedText("code", 120), "2FA code copied by Notiq. Clears in 2 min.");
  assert.equal(NP.copiedText("username", 0), "Username copied by Notiq.");
  assert.equal(NP.copiedText("username", -5), "Username copied by Notiq.");
  assert.match(NP.listText("unknown_op"), /Update Notiq/);
  assert.match(NP.listText("locked"), /Unlock Notiq/);
  assert.match(NP.listText("app_not_running"), /Open Notiq/);
  assert.match(NP.listText("something new"), /Couldn't load/);
  assert.equal(NP.actionText("unknown_op"), "Update Notiq to use this.");
  assert.equal(NP.actionText("toString"), "Something went wrong."); // no prototype lookups
  assert.equal(NP.listText("__proto__"), "Couldn't load your logins for this site.");
});

test("popupkit: arrow keys move between rows and back to the filter", () => {
  assert.equal(NP.nextRow("ArrowDown", -1, 3), 0);
  assert.equal(NP.nextRow("ArrowDown", 0, 3), 1);
  assert.equal(NP.nextRow("ArrowDown", 2, 3), 2);
  assert.equal(NP.nextRow("ArrowUp", 1, 3), 0);
  assert.equal(NP.nextRow("ArrowUp", 0, 3), -1);
  assert.equal(NP.nextRow("Home", 2, 3), 0);
  assert.equal(NP.nextRow("End", 0, 3), 2);
  assert.equal(NP.nextRow("ArrowDown", 0, 0), -1);
});

test("popupkit: avatar initial, status label, main panel", () => {
  assert.equal(NP.initial(A[0]), "W");
  assert.equal(NP.initial({ ...A[0], title: "  émile" }), "É");
  assert.equal(NP.initial({ ...A[0], title: "<img>" }), "I");
  assert.equal(NP.initial(A[2]), "L"); // "Login"
  assert.equal(NP.initial({ ...A[0], title: "***" }), "?");
  assert.equal(NP.statusLabel("on"), "Unlocked");
  assert.equal(NP.statusLabel("locked"), "Vault locked");
  assert.equal(NP.statusLabel("off"), "Notiq not running");
  assert.equal(NP.statusLabel("off", true), "Notiq not set up");
  assert.equal(NP.statusLabel("toString"), "Notiq not running");
  assert.equal(NP.mainPanel({ conn: "on" }), null);
  assert.equal(NP.mainPanel({ conn: "unknown" }), null);
  assert.equal(NP.mainPanel(), null);
  assert.equal(NP.mainPanel({ conn: "locked" }).action, "retry");
  assert.match(NP.mainPanel({ conn: "locked" }).title, /locked/);
  assert.match(NP.mainPanel({ conn: "off" }).title, /isn't running/);
  assert.match(NP.mainPanel({ conn: "off", noHost: true }).title, /set up/);
  assert.equal(NP.mainPanel({ conn: "update_app", detail: "Get 0.9" }).text, "Get 0.9");
  assert.equal(NP.mainPanel({ conn: "update_ext" }).action, "");
  // A page Notiq can't fill wins over the connection state; other tab errors are ignored.
  assert.equal(NP.mainPanel({ conn: "locked", pageError: "not_https" }).icon, "page");
  assert.equal(NP.mainPanel({ conn: "on", pageError: "bad_url" }).icon, "page");
  assert.equal(NP.mainPanel({ conn: "on", pageError: "no_tab" }), null);
});

// ---------- background.js popup handlers ----------
const EXT_ID = "notiq-test-id";
const PAGE = "https://accounts.example.com/signin";
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
const LIST = { ok: true, accounts: A };
function boot(reply, { url = PAGE } = {}) {
  const native = [];
  const onMessage = event();
  const tab = { id: 7, url, active: true };
  const injected = [];
  const chrome = {
    runtime: {
      id: EXT_ID, lastError: undefined, onMessage, getManifest: () => ({ version: "0.0.0-test" }),
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      sendNativeMessage: (_h, msg, cb) => { native.push(plain(msg)); queueMicrotask(() => cb(plain(reply(msg)))); },
    },
    storage: { session: area(), local: area() },
    tabs: { onRemoved: event(), onUpdated: event(), query: async () => [tab], sendMessage: () => {} },
    commands: { onCommand: event() },
    scripting: {
      executeScript: async (o) => {
        if (o.func.name === "probeFrame") return [{ frameId: 0, result: { origin: new URL(tab.url).origin, top: true, ancestors: [], fields: true, password: true } }];
        injected.push(plain(o.args));
        return [{ frameId: 0, result: 2 }];
      },
    },
    action: { openPopup: async () => {} },
  };
  const ctx = vm.createContext({ chrome, setTimeout: () => 0, queueMicrotask, URL, console });
  vm.runInContext(SHARED, ctx);
  vm.runInContext("globalThis.__now = Date.now(); Date.now = () => globalThis.__now;", ctx);
  vm.runInContext(BACKGROUND, ctx);
  return {
    native, tab, injected,
    vault: () => native.filter((m) => m.op !== "theme" && m.op !== "ping"),
    advance: (ms) => { ctx.__now += ms; },
    // From the toolbar popup (an extension page: no tab).
    popup(type, extra = {}) {
      return new Promise((resolve) => {
        const sender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` };
        const r = onMessage.fire({ type, ...extra }, sender, (x) => resolve(plain(x)))[0];
        if (r !== true) resolve(undefined);
      });
    },
    // From a content script of the tab's top frame.
    page(type, extra = {}) {
      return new Promise((resolve) => {
        const sender = { id: EXT_ID, url: tab.url, frameId: 0, tab };
        const r = onMessage.fire({ type, ...extra }, sender, (x) => resolve(plain(x)))[0];
        if (r !== true) resolve(undefined);
      });
    },
  };
}
const strip = ({ ext, protocol, ...rest }) => rest;

test("list asks the app for the active tab's host only and passes names through", async () => {
  const sw = boot((m) => (m.op === "list" ? { ...LIST, accounts: [{ ...A[0], password: "S3cret" }] } : { error: "x" }));
  const r = await sw.popup("list");
  assert.deepEqual(r, { ok: true, host: "accounts.example.com", accounts: [A[0]] });
  assert.deepEqual(sw.vault().map(strip), [{ op: "list", host: "accounts.example.com" }]);
  assert.equal(sw.vault()[0].protocol, 2); // tagged like every request
});

test("list errors: insecure page never asks; old app / locked are passed on", async () => {
  let sw = boot(() => LIST, { url: "http://example.com/login" });
  assert.deepEqual(await sw.popup("list"), { error: "not_https" });
  assert.equal(sw.vault().length, 0);
  sw = boot(() => ({ error: "unknown_op" }));
  assert.deepEqual(await sw.popup("list"), { error: "unknown_op", host: "accounts.example.com" });
  sw = boot(() => ({ error: "locked" }));
  assert.equal((await sw.popup("list")).error, "locked");
  sw = boot(() => ({ ok: true, accounts: "nope" }));
  assert.equal((await sw.popup("list")).error, "no_reply");
});

test("a page (content script) cannot list, copy or open", async () => {
  const sw = boot(() => LIST);
  for (const type of ["list", "copy", "open", "popupFill"]) {
    assert.equal(await sw.page(type, { account: A[0].account, what: "password" }), undefined, type);
  }
  assert.equal(sw.vault().length, 0);
});

test("copy: only a listed account, only known fields; the reply never holds the value", async () => {
  const sw = boot((m) => (m.op === "list" ? LIST : m.op === "copy" ? { ok: true, copied: m.what, clearAfter: 30, password: "S3cret" } : { error: "x" }));
  assert.deepEqual(await sw.popup("copy", { account: A[0].account, what: "password" }), { error: "stale" }); // no list yet
  await sw.popup("list");
  assert.deepEqual(await sw.popup("copy", { account: "Logins/Other.nqv", what: "password" }), { error: "stale" });
  assert.deepEqual(await sw.popup("copy", { account: A[0].account, what: "notes" }), { error: "bad_request" });
  const r = await sw.popup("copy", { account: A[0].account, what: "password" });
  assert.deepEqual(r, { ok: true, copied: "password", clearAfter: 30 });
  assert.deepEqual(sw.vault().map(strip).slice(1), [{ op: "copy", host: "accounts.example.com", account: A[0].account, what: "password" }]);
  // the list expires
  sw.advance(11 * 60 * 1000);
  assert.deepEqual(await sw.popup("copy", { account: A[0].account, what: "code" }), { error: "stale" });
});

test("copy / open on another site than the list's are refused", async () => {
  const sw = boot((m) => (m.op === "list" ? LIST : { ok: true }));
  await sw.popup("list");
  sw.tab.url = "https://evil.example.net/login";
  assert.deepEqual(await sw.popup("copy", { account: A[0].account, what: "username" }), { error: "stale" });
  assert.deepEqual(await sw.popup("open", { account: A[0].account }), { error: "stale" });
  assert.equal(sw.vault().length, 1);
});

test("copy errors from the app (declined, old app) come back as short codes", async () => {
  for (const error of ["denied", "unknown_op", "locked"]) {
    const sw = boot((m) => (m.op === "list" ? LIST : { error }));
    await sw.popup("list");
    assert.deepEqual(await sw.popup("copy", { account: A[1].account, what: "password" }), { error });
  }
});

test("open asks the app to show the listed entry", async () => {
  const sw = boot((m) => (m.op === "list" ? LIST : m.op === "open" ? { ok: true } : { error: "x" }));
  await sw.popup("list");
  assert.deepEqual(await sw.popup("open", { account: A[1].account }), { ok: true });
  assert.deepEqual(strip(sw.vault()[1]), { op: "open", host: "accounts.example.com", account: A[1].account });
});

test("row click fills the listed account through the normal fill (app approval) and only into this page", async () => {
  const CRED = { ok: true, username: "alice@home.example", password: "Home-Pw-9", title: "Home" };
  const sw = boot((m) => (m.op === "list" ? LIST : m.op === "fill" ? CRED : { error: "x" }));
  assert.deepEqual(await sw.popup("popupFill", { account: A[1].account }), { error: "stale" });
  await sw.popup("list");
  const r = await sw.popup("popupFill", { account: A[1].account });
  assert.equal(r.ok, true);
  assert.deepEqual(strip(sw.vault()[1]), { op: "fill", host: "accounts.example.com", account: A[1].account });
  assert.equal(sw.injected.length, 1);
  assert.equal(sw.injected[0][0], "accounts.example.com");
  assert.equal(sw.injected[0][1].password, "Home-Pw-9");
});

// ---------- popupkit.js: the bottom tab bar ----------
test("popupkit: tabs and the screens that belong to them", () => {
  assert.deepEqual([...NP.TABS], ["main", "gen", "settings"]);
  assert.ok(Object.isFrozen(NP.TABS) && Object.isFrozen(NP.SUB_VIEWS));
  for (const t of NP.TABS) assert.equal(NP.tabOf(t), t);
  for (const s of ["never", "hidden", "trusted"]) assert.equal(NP.tabOf(s), "settings");
  for (const bad of ["", "toString", "__proto__", undefined, null, "constructor"]) assert.equal(NP.tabOf(bad), "main", String(bad));
});

test("popupkit: arrow keys on the tab bar wrap around; other keys are ignored", () => {
  assert.equal(NP.nextTab("ArrowRight", 0, 3), 1);
  assert.equal(NP.nextTab("ArrowRight", 2, 3), 0);
  assert.equal(NP.nextTab("ArrowLeft", 0, 3), 2);
  assert.equal(NP.nextTab("ArrowLeft", 2, 3), 1);
  assert.equal(NP.nextTab("Home", 2, 3), 0);
  assert.equal(NP.nextTab("End", 0, 3), 2);
  for (const k of ["ArrowDown", "ArrowUp", "Enter", " ", "Tab", "a"]) assert.equal(NP.nextTab(k, 1, 3), -1, k);
  assert.equal(NP.nextTab("ArrowRight", -1, 3), -1);
  assert.equal(NP.nextTab("ArrowRight", 3, 3), -1);
  assert.equal(NP.nextTab("ArrowRight", 0, 0), -1);
  assert.equal(NP.nextTab("ArrowRight", 0, 1), 0);
});

test("popupkit: view changes slide by tab order; sub-screens slide in and back", () => {
  assert.equal(NP.slideDir("main", "gen"), "right");
  assert.equal(NP.slideDir("main", "settings"), "right");
  assert.equal(NP.slideDir("settings", "gen"), "left");
  assert.equal(NP.slideDir("gen", "main"), "left");
  assert.equal(NP.slideDir("settings", "never"), "fwd");
  assert.equal(NP.slideDir("trusted", "settings"), "back");
  assert.equal(NP.slideDir("hidden", "main"), "left"); // leaving Settings by the tab bar
  assert.equal(NP.slideDir("never", "hidden"), ""); // same tab, not its parent: no slide
  assert.equal(NP.slideDir("main", "main"), "");
});

test("popupkit: the site card's summary line", () => {
  assert.equal(NP.siteSummary({ count: 1 }), "1 saved login");
  assert.equal(NP.siteSummary({ count: 3, kind: "nomatch", on: true }), "3 saved logins");
  assert.equal(NP.siteSummary({ count: 0, kind: "loading" }), "Looking for saved logins…");
  assert.equal(NP.siteSummary({ count: 0, kind: "empty", on: true }), "No saved logins yet");
  // Locked / not running / errors: the state panel or the list's own line says it.
  assert.equal(NP.siteSummary({ count: 0, kind: "empty", on: false }), "");
  assert.equal(NP.siteSummary({ count: 0, kind: "error", on: true }), "");
  assert.equal(NP.siteSummary(), "");
  assert.equal(NP.siteSummary({ count: "3" }), "");
});
