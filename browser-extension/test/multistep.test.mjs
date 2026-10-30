// Unit tests for the multi-step login handoff in browser-extension/background.js
// (username page, then password page). The service worker runs in a vm with a
// small in-memory chrome.* mock; messages arrive as if from content scripts.
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
const EXT_ID = "notiq-test-id";
const CRED = { ok: true, username: "alice@example.com", password: "Step-Secret-1!", title: "Example" };

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
    async clear() { for (const k of Object.keys(data)) delete data[k]; },
  };
}

// A fresh service worker. `reply(msg)` answers native messages.
function boot(reply = (m) => (m.op === "fill" ? CRED : { error: "app_not_running" })) {
  const native = [];
  const onMessage = event(), onRemoved = event(), onUpdated = event();
  const chrome = {
    runtime: {
      id: EXT_ID, lastError: undefined, onMessage,
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      sendNativeMessage: (_host, msg, cb) => { native.push(msg); queueMicrotask(() => cb(reply(msg))); },
    },
    storage: { session: area(), local: area() },
    tabs: { onRemoved, onUpdated, query: async () => [], sendMessage: () => {} },
    commands: { onCommand: event() },
    scripting: { executeScript: async () => [] },
    action: { openPopup: async () => {} },
  };
  const ctx = vm.createContext({ chrome, setTimeout: () => 0, queueMicrotask, URL, console });
  vm.runInContext(SHARED, ctx);
  vm.runInContext("globalThis.__now = Date.now(); Date.now = () => globalThis.__now;", ctx);
  vm.runInContext(BACKGROUND, ctx);
  const sw = {
    ctx, chrome, native,
    vaultCalls: () => native.filter((m) => m.op !== "theme"),
    advance: (ms) => { ctx.__now += ms; },
    // A content-script message from the top frame (frameId 0) of `tabId` at `url`.
    send(type, extra = {}, { tabId = 7, url = "https://accounts.example.com/signin", frameId = 0, tabUrl = url, active = true } = {}) {
      return new Promise((resolve) => {
        const sender = { id: EXT_ID, url, frameId, tab: { id: tabId, url: tabUrl, active } };
        // Plain copies: objects made inside the vm have another realm's prototypes.
        const async = onMessage.fire({ type, ...extra }, sender, (r) => resolve(JSON.parse(JSON.stringify(r))))[0];
        if (async !== true) resolve(undefined); // not handled
      });
    },
    steps: () => Object.keys(chrome.storage.session.data).filter((k) => k.startsWith("step:")),
  };
  return sw;
}

test("username-only page, then password page: password filled once, Notiq asked once", async () => {
  const sw = boot();
  const r1 = await sw.send("fill", { step: true });
  assert.equal(r1.ok, true);
  assert.equal(r1.username, "alice@example.com");
  assert.equal(r1.password, "", "the password does not go to the username page");
  assert.deepEqual(sw.steps(), ["step:7"]);
  assert.equal(JSON.stringify(sw.chrome.storage.local.data).includes("Step-Secret-1!"), false);

  // Next page of the same sign-in (same host).
  const r2 = await sw.send("stepFill", {}, { url: "https://accounts.example.com/signin/challenge/pwd" });
  assert.equal(r2.ok, true);
  assert.equal(r2.password, "Step-Secret-1!");
  assert.equal(r2.username, "alice@example.com");
  assert.equal(r2.host, "accounts.example.com");
  assert.equal(sw.vaultCalls().length, 1, "no second request to Notiq");

  // Single use.
  assert.deepEqual(sw.steps(), []);
  assert.deepEqual(await sw.send("stepFill"), { none: true });
});

test("a normal fill (not a username-only page) holds nothing", async () => {
  const sw = boot();
  const r = await sw.send("fill");
  assert.equal(r.password, "Step-Secret-1!");
  assert.deepEqual(sw.steps(), []);
  assert.deepEqual(await sw.send("stepFill"), { none: true });
});

test("the held password expires after two minutes", async () => {
  const sw = boot();
  await sw.send("fill", { step: true });
  sw.advance(2 * 60 * 1000 + 1);
  assert.deepEqual(await sw.send("stepFill"), { none: true });
  assert.deepEqual(sw.steps(), [], "dropped when found expired");

  const sw2 = boot();
  await sw2.send("fill", { step: true });
  sw2.advance(2 * 60 * 1000 - 1000);
  assert.equal((await sw2.send("stepFill")).password, "Step-Secret-1!", "still there just before expiry");
});

test("another site gets nothing, and visiting it drops the held password", async () => {
  const sw = boot();
  await sw.send("fill", { step: true });
  assert.deepEqual(await sw.send("stepFill", {}, { url: "https://evil.example.net/login" }), { none: true });
  assert.deepEqual(sw.steps(), []);
  // Even if the right site comes back afterwards.
  assert.deepEqual(await sw.send("stepFill"), { none: true });

  // Look-alike hosts are other sites too.
  for (const url of ["https://example.com.evil.net/x", "https://notexample.com/x", "http://accounts.example.com/x"]) {
    const s = boot();
    await s.send("fill", { step: true });
    assert.deepEqual(await s.send("stepFill", {}, { url }), { none: true }, url);
  }
});

test("same site, other subdomain: allowed by the existing same-site rule", async () => {
  const sw = boot();
  await sw.send("fill", { step: true });
  const r = await sw.send("stepFill", {}, { url: "https://login.example.com/password" });
  assert.equal(r.password, "Step-Secret-1!");
  assert.equal(r.host, "login.example.com");
});

test("another tab gets nothing; a same-site frame of the right tab may claim it", async () => {
  const sw = boot();
  await sw.send("fill", { step: true });
  assert.deepEqual(await sw.send("stepFill", {}, { tabId: 8 }), { none: true });
  assert.deepEqual(sw.steps(), ["step:7"], "the other tab's request does not touch it");
  // A cross-site subframe of the right tab is refused by the sender check.
  assert.equal(await sw.send("stepFill", {}, { frameId: 3, url: "https://ads.other.net/f", tabUrl: "https://accounts.example.com/signin" }), undefined);
  assert.deepEqual(sw.steps(), ["step:7"]);
  const r = await sw.send("stepFill", {}, { frameId: 3, url: "https://auth.example.com/f", tabUrl: "https://accounts.example.com/signin" });
  assert.equal(r.password, "Step-Secret-1!");
});

test("closing the tab clears the held password", async () => {
  const sw = boot();
  await sw.send("fill", { step: true });
  assert.deepEqual(sw.steps(), ["step:7"]);
  sw.chrome.tabs.onRemoved.fire(7);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sw.steps(), []);
  assert.deepEqual(await sw.send("stepFill"), { none: true });
});

test("navigating the tab to another site clears it; same-site navigation keeps it", async () => {
  const sw = boot();
  await sw.send("fill", { step: true });
  sw.chrome.tabs.onUpdated.fire(7, { url: "https://accounts.example.com/signin/v2/pwd" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sw.steps(), ["step:7"]);
  sw.chrome.tabs.onUpdated.fire(7, { url: "https://other.org/" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sw.steps(), []);
});

test("a locked vault, a new fill or a cancel drop the held password", async () => {
  let locked = false;
  const sw = boot((m) => (locked ? { error: "locked" } : m.op === "fill" ? CRED : { error: "app_not_running" }));
  await sw.send("fill", { step: true });
  await sw.send("fill", { step: true }, { tabId: 9, url: "https://other.org/login" });
  assert.deepEqual(sw.steps().sort(), ["step:7", "step:9"]);
  locked = true;
  const r = await sw.send("fill", {}, { tabId: 11, url: "https://third.org/login" });
  assert.equal(r.error, "locked");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sw.steps(), [], "every tab's held password is gone");

  locked = false;
  await sw.send("fill", { step: true });
  await sw.send("fill"); // a new, ordinary fill in the same tab replaces it
  assert.deepEqual(sw.steps(), []);

  await sw.send("fill", { step: true });
  assert.deepEqual(await sw.send("stepCancel"), { ok: true });
  assert.deepEqual(sw.steps(), []);
});

test("a background tab is not filled, but keeps the password for when it is active", async () => {
  const sw = boot();
  await sw.send("fill", { step: true });
  assert.deepEqual(await sw.send("stepFill", {}, { active: false }), { none: true });
  assert.equal((await sw.send("stepFill")).password, "Step-Secret-1!");
});

test("a login without a username is filled in one go (nothing to hold for)", async () => {
  const sw = boot((m) => (m.op === "fill" ? { ok: true, username: "", password: "Pw-Only" } : { error: "x" }));
  const r = await sw.send("fill", { step: true });
  assert.equal(r.password, "Pw-Only");
  assert.deepEqual(sw.steps(), []);
});

test("toolbar fill on a username-only tab: username now, password held for the next step", async () => {
  for (const hasPassword of [false, true]) {
    const sw = boot();
    const injected = [];
    sw.chrome.tabs.query = async () => [{ id: 7, url: "https://accounts.example.com/signin", active: true }];
    sw.chrome.scripting.executeScript = async (o) => {
      if (o.func.name === "fillPage") { injected.push(JSON.parse(JSON.stringify(o.args))); return [{ frameId: 0, result: 1 }]; }
      return [{ frameId: 0, result: hasPassword }]; // the password-field probe
    };
    const r = await sw.ctx.fillActiveTab();
    assert.equal(r.ok, true);
    assert.equal(injected[0][1].username, "alice@example.com");
    if (hasPassword) {
      assert.equal(injected[0][1].password, "Step-Secret-1!", "a page with a password field is filled in one go");
      assert.deepEqual(sw.steps(), []);
    } else {
      assert.equal(injected[0][1].password, "", "the username-only page never receives the password");
      assert.deepEqual(sw.steps(), ["step:7"]);
      assert.equal((await sw.send("stepFill")).password, "Step-Secret-1!");
    }
  }
});
