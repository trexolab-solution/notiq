// Unit tests for the in-page login menu and the strong password card: the pure helpers in shared.js /
// generator.js, and the background's `inlineList` / `openPopup` handlers, the fill of a listed account and the
// "Use and save" message flow (capture + save, no second offer).
//   node --test browser-extension/test/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = readFileSync(join(dir, "shared.js"), "utf8");
const BACKGROUND = readFileSync(join(dir, "background.js"), "utf8");
const GENERATOR = readFileSync(join(dir, "generator.js"), "utf8");
const CONTENT = readFileSync(join(dir, "content.js"), "utf8");
const POPUP_GEN = readFileSync(join(dir, "popup-generator.js"), "utf8");
const EXT_ID = "notiq-test-id";
const plain = (o) => (o === undefined ? o : JSON.parse(JSON.stringify(o)));

const sctx = vm.createContext({ URL });
vm.runInContext(SHARED, sctx);
const NS = sctx.NotiqShared;
const gctx = vm.createContext({ crypto: globalThis.crypto, Uint32Array });
vm.runInContext(GENERATOR, gctx);
const G = gctx.NotiqGen;

const LIST = [
  { account: "Bank/alex", title: "Example Bank", username: "alex.morgan@example.com", totp: true, password: "LEAK-1", secret: "JBSWY3DP" },
  { account: "Bank/joint", title: "Joint account", username: "sam.morgan@example.com", totp: false },
  { account: "Bank/kids", title: "Kids account", username: "jamie.morgan", totp: true },
];

// ---------- shared.js helpers ----------
test("inlineRows keeps only account, title, username and the 2FA flag (no password, no secret)", () => {
  const rows = plain(NS.inlineRows(LIST));
  assert.equal(rows.length, 3);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ["account", "title", "totp", "username"]);
  assert.ok(!JSON.stringify(rows).includes("LEAK-1") && !JSON.stringify(rows).includes("JBSWY3DP"));
  assert.deepEqual(rows[0], { account: "Bank/alex", title: "Example Bank", username: "alex.morgan@example.com", totp: true });
});
test("inlineRows drops malformed entries, strips control characters and caps the list", () => {
  const rows = plain(NS.inlineRows([null, { account: "" }, { account: 5 }, { account: "a", title: "T\u0000x", username: 3 }]));
  assert.deepEqual(rows, [{ account: "a", title: "T x", username: "", totp: false }]);
  assert.equal(NS.inlineRows(Array.from({ length: 80 }, (_, i) => ({ account: `a${i}` }))).length, NS.MAX_INLINE_ROWS);
  assert.deepEqual(plain(NS.inlineRows("nope")), []);
});
test("filterRows matches what is typed in the username or the title, case-insensitively", () => {
  const rows = NS.inlineRows(LIST);
  assert.equal(NS.filterRows(rows, "").length, 3);
  assert.deepEqual(plain(NS.filterRows(rows, "  SAM ").map((r) => r.account)), ["Bank/joint"]);
  assert.deepEqual(plain(NS.filterRows(rows, "kids").map((r) => r.account)), ["Bank/kids"]);
  assert.deepEqual(plain(NS.filterRows(rows, "morgan@").map((r) => r.account)), ["Bank/alex", "Bank/joint"]);
  assert.equal(NS.filterRows(rows, "zzz").length, 0);
});
test("avatarLetter: first letter or digit of the title, else the username", () => {
  assert.equal(NS.avatarLetter("example bank", "x"), "E");
  assert.equal(NS.avatarLetter("  (#) ", "jamie"), "J");
  assert.equal(NS.avatarLetter("", ""), "?");
  assert.equal(NS.avatarLetter("ölbank", ""), "Ö");
});
test("menuMove: ArrowDown enters / walks the menu, ArrowUp from the first row returns to the field", () => {
  assert.equal(NS.menuMove("ArrowDown", -1, 4), 0);
  assert.equal(NS.menuMove("ArrowDown", 0, 4), 1);
  assert.equal(NS.menuMove("ArrowDown", 3, 4), 3);
  assert.equal(NS.menuMove("ArrowUp", 2, 4), 1);
  assert.equal(NS.menuMove("ArrowUp", 0, 4), -1);
  assert.equal(NS.menuMove("Home", 2, 4), 0);
  assert.equal(NS.menuMove("End", 0, 4), 3);
  assert.equal(NS.menuMove("Enter", 0, 4), null);
  assert.equal(NS.menuMove("a", 0, 4), null);
  assert.equal(NS.menuMove("ArrowDown", -1, 0), null);
});
test("isNewPassword: new-password autocomplete, new / confirm hints or 2+ password fields; never a current one", () => {
  assert.equal(NS.isNewPassword({ autocomplete: "new-password", hint: "pw", passwords: 1 }), true);
  assert.equal(NS.isNewPassword({ autocomplete: "section-x NEW-PASSWORD", hint: "", passwords: 1 }), true);
  assert.equal(NS.isNewPassword({ autocomplete: "", hint: "confirm_password", passwords: 1 }), true);
  assert.equal(NS.isNewPassword({ autocomplete: "", hint: "newPassword", passwords: 1 }), true);
  assert.equal(NS.isNewPassword({ autocomplete: "", hint: "password", passwords: 2 }), true);
  assert.equal(NS.isNewPassword({ autocomplete: "", hint: "password", passwords: 1 }), false);
  assert.equal(NS.isNewPassword({ autocomplete: "current-password", hint: "", passwords: 3 }), false);
  assert.equal(NS.isNewPassword({ autocomplete: "", hint: "old_password", passwords: 3 }), false);
  assert.equal(NS.isCurrentPassword({ autocomplete: "current-password" }), true);
  assert.equal(NS.isNewPassword(null), false);
});
test("siteRulesApply: the site's rules win only when they are stricter than the options", () => {
  const o = G.sanitize({ length: 20 });
  assert.equal(NS.siteRulesApply({ maxLength: 0, minLength: 0, rules: "", pattern: "" }, o), false);
  assert.equal(NS.siteRulesApply({ maxLength: 64, minLength: 8, rules: "", pattern: "" }, o), false);
  assert.equal(NS.siteRulesApply({ maxLength: 16, minLength: 0, rules: "", pattern: "" }, o), true);
  assert.equal(NS.siteRulesApply({ maxLength: 0, minLength: 30, rules: "", pattern: "" }, o), true);
  assert.equal(NS.siteRulesApply({ maxLength: 0, minLength: 0, rules: "required: digit;", pattern: "" }, o), true);
  assert.equal(NS.siteRulesApply({ maxLength: 0, minLength: 0, rules: "", pattern: "[a-z]+" }, o), true);
});
test("passwordRuns splits digits / symbols / letters for tinting, without losing characters", () => {
  const runs = plain(NS.passwordRuns("ab12#$Cd9"));
  assert.deepEqual(runs, [{ kind: "", text: "ab" }, { kind: "d", text: "12" }, { kind: "s", text: "#$" }, { kind: "", text: "Cd" }, { kind: "d", text: "9" }]);
  assert.equal(runs.map((r) => r.text).join(""), "ab12#$Cd9");
  assert.deepEqual(plain(NS.passwordRuns("")), []);
});
test("generatedCapture: the exact capture payload shape background.js accepts", () => {
  const p = plain(NS.generatedCapture({ host: "Git.Example.org", url: "https://git.example.org/signup", username: " alex@example.com ",
    password: "Gen-Pass-123!", title: "Create\u0000account", change: false, current: "old" }));
  assert.deepEqual(p, { host: "git.example.org", url: "https://git.example.org/signup", username: "alex@example.com",
    password: "Gen-Pass-123!", title: "Create account", change: false });
  const c = plain(NS.generatedCapture({ host: "a.com", password: "new", change: true, current: "old" }));
  assert.equal(c.current, "old");
  assert.equal(c.change, true);
  assert.equal(NS.generatedCapture({ host: "a.com", password: "same", change: true, current: "same" }).current, undefined);
  assert.equal(NS.generatedCapture({ host: "a.com", password: "" }), null);
  assert.equal(NS.generatedCapture({ host: "a.com", password: "x".repeat(1025) }), null);
  assert.equal(NS.generatedCapture(null), null);
});

// ---------- generator.js ----------
test("generator: options live under one storage key shared by the popup and the in-page card", () => {
  assert.equal(G.STORAGE_KEY, "genOptions");
  assert.match(POPUP_GEN, /G\.STORAGE_KEY/);
  assert.match(CONTENT, /GEN\.STORAGE_KEY/);
  assert.match(CONTENT, /genOptions: null/); // read at start-up with the other settings
  // A round trip through storage (JSON) keeps the options as they are.
  const o = G.sanitize({ length: 33, digits: false, symbols: true, avoidAmbiguous: false });
  assert.deepEqual(plain(G.sanitize(JSON.parse(JSON.stringify(o)))), plain(o));
  assert.equal(G.generate(o).length, 33);
  assert.ok(!/[0-9]/.test(G.generate(o)));
});
test("generator: strengthOf rates a given password by its length and classes", () => {
  assert.equal(G.strengthOf("").bits, 0);
  assert.equal(G.strengthOf("aaaaaaaa").label, "Weak");
  const s = G.strengthOf("Ab3$Ab3$Ab3$Ab3$Ab3$");
  assert.equal(s.level, 3);
  assert.equal(s.label, "Very strong");
});
test("content.js never logs and builds the panels with textContent only", () => {
  assert.ok(!/console\.(log|info|debug|warn|error)/.test(CONTENT));
  assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/.test(CONTENT));
});

// ---------- background.js ----------
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
const PAGE = "https://online.examplebank.com/login";
function boot(reply, { incognito = false } = {}) {
  const native = [];
  const popups = [];
  let popupThrows = false;
  const chrome = {
    runtime: {
      id: EXT_ID, lastError: undefined, onMessage: event(), getManifest: () => ({ version: "0.0.0-test" }),
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      sendNativeMessage: (_h, msg, cb) => { native.push(plain(msg)); queueMicrotask(() => cb(plain(reply(msg)))); },
    },
    storage: { session: area(), local: area() },
    tabs: { onRemoved: event(), onUpdated: event(), query: async () => [], sendMessage: () => {} },
    commands: { onCommand: event() },
    scripting: { executeScript: async () => [] },
    action: { openPopup: async () => { if (popupThrows) throw new Error("no gesture"); popups.push(1); } },
    contextMenus: { create: () => {}, removeAll: (cb) => cb && cb(), onClicked: event(), update: () => {} },
  };
  const ctx = vm.createContext({ chrome, setTimeout: () => 0, queueMicrotask, URL, console });
  vm.runInContext(SHARED, ctx);
  vm.runInContext("globalThis.__now = Date.now(); Date.now = () => globalThis.__now;", ctx);
  vm.runInContext(BACKGROUND, ctx);
  return {
    chrome, native, popups,
    failPopup: () => { popupThrows = true; },
    advance: (ms) => { ctx.__now += ms; },
    ops: () => native.filter((m) => m.op !== "theme" && m.op !== "ping").map((m) => m.op),
    send(type, extra = {}, { tabId = 7, url = PAGE, frameId = 0, tabUrl = url, active = true } = {}) {
      return new Promise((resolve) => {
        const sender = { id: EXT_ID, url, frameId, tab: { id: tabId, url: tabUrl, active, incognito } };
        const r = chrome.runtime.onMessage.fire({ type, ...extra }, sender, (x) => resolve(plain(x)))[0];
        if (r !== true) resolve(undefined);
      });
    },
  };
}
const listReply = (m) => (m.op === "list" ? { ok: true, accounts: LIST }
  : m.op === "fill" ? { ok: true, username: "alex.morgan@example.com", password: "Bank-Secret-1", title: "Example Bank" }
    : m.op === "save_check" ? { ok: true, action: "save" }
      : m.op === "save" ? { ok: true, status: "saved" } : { error: "app_not_running" });

test("inlineList: the popup's list for the TOP page's host, reduced to ids, titles, usernames, 2FA flag", async () => {
  const sw = boot(listReply);
  const r = await sw.send("inlineList", { host: "evil.example" });
  assert.equal(r.ok, true);
  assert.equal(r.host, "online.examplebank.com");
  const req = sw.native.find((m) => m.op === "list");
  assert.equal(req.host, "online.examplebank.com"); // never the message's host
  assert.deepEqual(Object.keys(r.accounts[0]).sort(), ["account", "title", "totp", "username"]);
  assert.ok(!JSON.stringify(r).includes("LEAK-1") && !JSON.stringify(r).includes("JBSWY3DP"));
  // A same-site subframe asks for the top host too.
  const f = await sw.send("inlineList", {}, { tabId: 8, url: "https://auth.examplebank.com/frame", frameId: 3, tabUrl: PAGE });
  assert.equal(f.host, "online.examplebank.com");
  // A cross-site frame gets nothing.
  assert.equal(await sw.send("inlineList", {}, { tabId: 9, url: "https://evil.example/x", frameId: 4, tabUrl: PAGE }), undefined);
});
test("inlineList: reused for a while per tab + host, so repeated focus doesn't spam Notiq", async () => {
  const sw = boot(listReply);
  await sw.send("inlineList");
  await sw.send("inlineList");
  await sw.send("inlineList");
  assert.equal(sw.ops().filter((o) => o === "list").length, 1);
  sw.advance(16 * 1000);
  await sw.send("inlineList");
  assert.equal(sw.ops().filter((o) => o === "list").length, 2);
});
test("inlineList: locked passes through (short reuse), an unreachable Notiq is not asked again for 30 s", async () => {
  let state = "locked";
  const sw = boot((m) => (m.op === "list" ? (state === "locked" ? { error: "locked" } : { error: "app_not_running" }) : { error: "x" }));
  assert.equal((await sw.send("inlineList")).error, "locked");
  sw.advance(3000);
  state = "down";
  assert.equal((await sw.send("inlineList")).error, "app_not_running");
  sw.advance(10 * 1000);
  await sw.send("inlineList");
  assert.equal(sw.ops().filter((o) => o === "list").length, 2);
});
test("inlineList: nothing for a background tab, with the icons off, on a hidden site or in a private window", async () => {
  const sw = boot(listReply);
  assert.equal((await sw.send("inlineList", {}, { active: false })).error, "denied");
  await sw.chrome.storage.local.set({ hiddenSites: ["online.examplebank.com"] });
  assert.equal((await sw.send("inlineList")).error, "off");
  await sw.chrome.storage.local.set({ hiddenSites: [], showIcon: false });
  assert.equal((await sw.send("inlineList")).error, "off");
  assert.equal(sw.ops().length, 0);
  const priv = boot(listReply, { incognito: true });
  assert.equal((await priv.send("inlineList")).error, "incognito_off");
  assert.equal(priv.ops().length, 0);
});
test("a row's fill names its account and still goes through Notiq's fill (approval); unlisted accounts are refused", async () => {
  const sw = boot(listReply);
  assert.equal((await sw.send("fill", { account: "Bank/joint" })).error, "stale"); // not listed yet
  await sw.send("inlineList");
  const r = await sw.send("fill", { account: "Bank/joint" });
  assert.equal(r.ok, true);
  const fill = sw.native.filter((m) => m.op === "fill");
  assert.equal(fill.length, 1);
  assert.equal(fill[0].account, "Bank/joint");
  assert.equal(fill[0].host, "online.examplebank.com");
  assert.equal((await sw.send("fill", { account: "Other/one" })).error, "stale");
  // Another tab's list doesn't count.
  assert.equal((await sw.send("fill", { account: "Bank/kids" }, { tabId: 12 })).error, "stale");
  // A list for another site in the same tab doesn't either.
  assert.equal((await sw.send("fill", { account: "Bank/kids" }, { url: "https://other.example/login" })).error, "stale");
});
test("openPopup: opens the toolbar popup; refused when the browser won't (the page then uses the normal fill)", async () => {
  const sw = boot(listReply);
  assert.equal((await sw.send("openPopup")).ok, true);
  assert.equal(sw.popups.length, 1);
  sw.failPopup();
  assert.equal((await sw.send("openPopup")).error, "unsupported");
  assert.equal((await sw.send("openPopup", {}, { active: false })).error, "denied");
});
test("Use and save: capture + save reach Notiq's save (its prompt confirms); no second offer for it", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const native = [];
  const sw = boot((m) => { native.push(m.op); return listReply(m); });
  // Hold the save reply until we say so, to look at the page's offer meanwhile.
  const orig = sw.chrome.runtime.sendNativeMessage;
  sw.chrome.runtime.sendNativeMessage = (h, msg, cb) => (msg.op === "save" ? gate.then(() => orig(h, msg, cb)) : orig(h, msg, cb));
  const payload = plain(NS.generatedCapture({ host: "online.examplebank.com", url: PAGE, username: "alex.morgan@example.com",
    password: "Gen-Pass-123!", title: "Sign up", change: false }));
  assert.deepEqual((await sw.send("capture", { payload })), { ok: true });
  const saving = sw.send("save");
  await new Promise((r) => setTimeout(r, 0));
  // While Notiq's Save prompt is open, the page's normal offer stays away (no double prompt).
  assert.deepEqual(await sw.send("pending"), { pending: null });
  release();
  const res = await saving;
  assert.deepEqual(res, { ok: true, status: "saved" });
  const save = sw.native.find((m) => m.op === "save");
  assert.equal(save.host, "online.examplebank.com");
  assert.equal(save.username, "alex.morgan@example.com");
  assert.equal(save.password, "Gen-Pass-123!");
  // Saved: nothing pending any more, so the later form submit's check finds nothing to offer.
  assert.deepEqual(await sw.send("pending"), { pending: null });
  // And when the page does capture the same login again, Notiq's save_check answers "none": no card.
  const sw2 = boot((m) => (m.op === "save_check" ? { ok: true, action: "none" } : listReply(m)));
  await sw2.send("capture", { payload });
  assert.deepEqual(await sw2.send("pending"), { pending: null });
});
test("Use and save respects Never save for this site (the background skips the capture)", async () => {
  const sw = boot(listReply);
  await sw.chrome.storage.local.set({ neverSave: ["online.examplebank.com"] });
  const payload = plain(NS.generatedCapture({ host: "online.examplebank.com", url: PAGE, username: "a", password: "Gen-1!aaaaaaaa", title: "" }));
  assert.equal((await sw.send("capture", { payload })).skipped, true);
  assert.equal((await sw.send("save")).error, "expired");
  assert.ok(!sw.ops().includes("save"));
});
test("the focus suggestion (login menu / strong password card) is on by default", async () => {
  assert.match(BACKGROUND, /suggestOnFocus: true/);
  assert.match(CONTENT, /suggestOnFocus: true, neverSave/);
});
