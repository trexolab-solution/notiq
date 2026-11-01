// Unit tests for the experimental passkey support: passkeys.js (background helpers), passkey-page.js (MAIN-world
// wrapper of navigator.credentials) and passkey-bridge.js (isolated-world bridge), each run in a small fake window.
//   node --test browser-extension/test/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(dir, f), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- passkeys.js ----------
const ctx = vm.createContext({ URL, TextEncoder, btoa });
vm.runInContext(read("shared.js"), ctx);
vm.runInContext(read("passkeys.js"), ctx);
const PK = ctx.NotiqPasskeys;
const plain = (o) => JSON.parse(JSON.stringify(o));
const b64u = (s) => Buffer.from(s).toString("base64url");

test("passkeys.js defines a frozen NotiqPasskeys", () => {
  assert.ok(PK && Object.isFrozen(PK));
});

test("passkey origins: https domains and http://localhost only", () => {
  assert.deepEqual(plain(PK.passkeyOrigin("https://www.github.com/login")), { origin: "https://www.github.com", host: "www.github.com" });
  assert.deepEqual(plain(PK.passkeyOrigin("http://localhost:8000/x")), { origin: "http://localhost:8000", host: "localhost" });
  for (const bad of ["http://github.com/", "https://1.2.3.4/", "http://127.0.0.1/", "https://[::1]/", "ftp://x.com/", "chrome://settings", "about:blank", "nonsense"]) {
    assert.equal(PK.passkeyOrigin(bad), null, bad);
  }
});

test("RP ID rule: the host or a registrable parent, never a public suffix", () => {
  const ok = [["github.com", "github.com"], ["github.com", "www.github.com"], ["example.co.uk", "login.example.co.uk"],
    ["me.github.io", "me.github.io"], ["localhost", "localhost"]];
  for (const [rp, host] of ok) assert.equal(PK.rpIdValid(rp, host), true, `${rp} for ${host}`);
  const bad = [["com", "github.com"], ["co.uk", "example.co.uk"], ["github.io", "me.github.io"], ["evil.com", "github.com"],
    ["hub.com", "github.com"], ["www.github.com", "github.com"], ["other.github.io", "me.github.io"], ["localhost", "a.localhost"],
    ["GitHub.com", "github.com"], ["", "github.com"], ["github.com.", "github.com"], ["127.0.0.1", "127.0.0.1"], [5, "github.com"]];
  for (const [rp, host] of bad) assert.equal(PK.rpIdValid(rp, host), false, `${rp} for ${host}`);
});

const page = { origin: "https://www.github.com", host: "www.github.com" };
const createOpts = (over = {}) => ({
  challenge: b64u("challenge-1234567"), rp: { id: "github.com", name: "GitHub" },
  user: { id: b64u("user-1"), name: "octo", displayName: "Octo\u0007Cat" }, algs: [-8, -7], exclude: [b64u("old")], credProps: true, ...over,
});

test("create: the client data is built from the frame's origin; the app request is clean", () => {
  const r = plain(PK.appRequest("create", createOpts(), page));
  assert.equal(r.req.op, "passkey_create");
  assert.equal(r.req.origin, "https://www.github.com");
  assert.equal(r.req.rpId, "github.com");
  assert.deepEqual(r.req.user, { id: b64u("user-1"), name: "octo", displayName: "Octo Cat" });
  assert.deepEqual(r.req.exclude, [b64u("old")]);
  const cd = Buffer.from(r.req.clientDataJSON, "base64url").toString();
  assert.equal(cd, `{"type":"webauthn.create","challenge":"${b64u("challenge-1234567")}","origin":"https://www.github.com","crossOrigin":false}`);
  assert.equal(r.clientData, r.req.clientDataJSON);
  assert.equal(r.credProps, true);
  // A missing rp.id means the page's own host.
  assert.equal(PK.appRequest("create", createOpts({ rp: { name: "x" } }), page).req.rpId, "www.github.com");
});

test("create: bad requests never reach the app", () => {
  const bad = [
    createOpts({ rp: { id: "evil.com" } }), createOpts({ rp: { id: "com" } }), createOpts({ challenge: "" }),
    createOpts({ challenge: "a+b/" }), createOpts({ user: { id: "", name: "x" } }), createOpts({ user: null }),
    createOpts({ algs: [-257] }), createOpts({ algs: "x" }), createOpts({ exclude: ["bad id!"] }),
    createOpts({ exclude: Array(65).fill("AA") }), createOpts({ user: { id: b64u("x".repeat(65)) } }), null, [],
  ];
  for (const o of bad) assert.ok(PK.appRequest("create", o, page).error, JSON.stringify(o));
  assert.ok(PK.appRequest("delete", createOpts(), page).error);
});

test("get: RP ID, allow list and client data", () => {
  const r = plain(PK.appRequest("get", { challenge: "AAAA", rpId: "github.com", allow: [b64u("c1")] }, page));
  assert.deepEqual(Object.keys(r.req).sort(), ["allow", "clientDataJSON", "op", "origin", "rpId"]);
  assert.equal(JSON.parse(Buffer.from(r.req.clientDataJSON, "base64url")).type, "webauthn.get");
  assert.ok(PK.appRequest("get", { challenge: "AAAA", rpId: "evil.com" }, page).error);
  assert.equal(PK.appRequest("get", { challenge: "AAAA" }, page).req.rpId, "www.github.com");
});

test("app replies are validated strictly; failures fall back to the browser", () => {
  const sent = PK.appRequest("get", { challenge: "AAAA", rpId: "github.com", allow: ["YQ"] }, page);
  const good = { ok: true, credentialId: "YQ", authenticatorData: "AAAA", signature: "MEUC", userHandle: "dQ" };
  const r = plain(PK.pageResult("get", good, sent));
  const { ok, ...fields } = good;
  assert.equal(ok, true);
  assert.deepEqual(r, { ok: true, credential: { ...fields, clientDataJSON: sent.clientData } });
  assert.equal(r.credential.clientDataJSON, sent.clientData);
  assert.equal(r.credential.credentialId, "YQ");
  // A credential the site didn't allow, or anything malformed, is not handed to the page.
  for (const bad of [{ ...good, credentialId: "Yg" }, { ...good, signature: "" }, { ...good, ok: "true" }, { error: "denied" },
    { error: "no_passkey" }, { error: "app_not_running" }, null]) {
    assert.deepEqual(plain(PK.pageResult("get", bad, sent)), { fallback: true }, JSON.stringify(bad));
  }
  const csent = PK.appRequest("create", createOpts(), page);
  const cgood = { ok: true, credentialId: "YQ", attestationObject: "o2Nm", authenticatorData: "AAAA", publicKey: "MFkw", alg: -7, key: "SECRET" };
  const c = plain(PK.pageResult("create", cgood, csent));
  assert.equal(c.ok, true);
  assert.equal("key" in c.credential, false, "only known fields are passed on");
  assert.equal(c.credential.credProps, true);
  assert.deepEqual(plain(PK.pageResult("create", { error: "excluded" }, csent)), { error: "excluded" });
  assert.deepEqual(plain(PK.pageResult("create", { ...cgood, alg: -257 }, csent)), { fallback: true });
  assert.deepEqual(plain(PK.pageResult("get", { error: "excluded" }, sent)), { fallback: true });
});

test("frames: the top page and same-origin subframes only", () => {
  const top = "https://www.github.com";
  assert.equal(PK.frameOk(0, top, top, null), true);
  assert.equal(PK.frameOk(3, top, top, [top]), true);
  assert.equal(PK.frameOk(3, top, top, [top, top]), true);
  assert.equal(PK.frameOk(3, top, top, null), false, "unknown ancestors (Firefox): browser dialog");
  assert.equal(PK.frameOk(3, top, top, ["https://evil.com", top]), false);
  assert.equal(PK.frameOk(3, "https://login.github.com", top, [top]), false, "same-site but cross-origin");
  assert.equal(PK.frameOk(0, "https://evil.com", top, null), false);
});

// ---------- a fake window for the page script and the bridge ----------
function fakeWindow({ origin = "https://www.github.com", active = true } = {}) {
  const listeners = [];
  const native = { create: [], get: [] };
  class CredentialsContainer {}
  CredentialsContainer.prototype.create = function create(o) { native.create.push(o); return Promise.resolve("native-create"); };
  CredentialsContainer.prototype.get = function get(o) { native.get.push(o); return Promise.resolve("native-get"); };
  class PublicKeyCredential {}
  class AuthenticatorAttestationResponse {}
  class AuthenticatorAssertionResponse {}
  const win = {
    CredentialsContainer, PublicKeyCredential, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse,
    location: { origin, ancestorOrigins: [] },
    crypto: { randomUUID: () => Math.random().toString(16).slice(2) },
    navigator: { credentials: new CredentialsContainer(), userActivation: { isActive: active } },
    addEventListener: (t, fn) => { if (t === "message") listeners.push(fn); },
    postMessage(data, targetOrigin) {
      assert.equal(targetOrigin, origin);
      const copy = structuredClone(data);
      setTimeout(() => { for (const fn of [...listeners]) fn({ source: win.self, origin, data: structuredClone(copy) }); }, 0);
    },
    // A message from another frame (different source) or another origin.
    inject(data, extra) { for (const fn of [...listeners]) fn({ source: {}, origin, data, ...extra }); },
    native,
    ArrayBuffer, Uint8Array, DOMException, TypeError, Error, Promise, Object, Array, String, Number, Math, JSON, Map, Set,
    btoa, atob, setTimeout,
  };
  win.window = win;
  win.globalThis = win;
  return win;
}

function loadPage(win) {
  const c = vm.createContext(win);
  win.self = vm.runInContext("globalThis", c); // what `window` is inside the context
  vm.runInContext(read("passkey-page.js"), c);
  return win.navigator.credentials;
}

// The bridge side of the channel, answering each request with `answer(request)`.
function fakeBridge(win, answer) {
  const seen = [];
  win.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== win.self || !d || d.tag !== "notiq-passkey" || d.dir !== "req") return;
    seen.push(d);
    const res = answer(d);
    if (res) win.postMessage({ ...res, tag: "notiq-passkey", dir: "res", id: d.id }, win.location.origin);
  });
  return seen;
}

const bytes = (s) => new TextEncoder().encode(s);
const createArgs = (extra = {}) => ({
  publicKey: {
    challenge: bytes("challenge-1234567"), rp: { id: "github.com", name: "GitHub" },
    user: { id: bytes("user-1"), name: "octo", displayName: "Octo" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [{ type: "public-key", id: bytes("old") }],
    ...extra,
  },
});

test("page script: non-passkey, conditional and cross-platform requests go straight to the browser", async () => {
  const win = fakeWindow();
  const creds = loadPage(win);
  const seen = fakeBridge(win, () => ({ fallback: true }));
  assert.equal(await creds.get({ password: true }), "native-get");
  assert.equal(await creds.get({ mediation: "conditional", publicKey: { challenge: bytes("x") } }), "native-get");
  assert.equal(await creds.create(createArgs({ authenticatorSelection: { authenticatorAttachment: "cross-platform" } })), "native-create");
  assert.equal(await creds.create({ publicKey: { challenge: bytes("x") } }), "native-create", "malformed: no user");
  assert.equal(seen.length, 0);
});

test("page script: a fallback answer runs the browser's own create with the original options", async () => {
  const win = fakeWindow();
  const creds = loadPage(win);
  const seen = fakeBridge(win, () => ({ fallback: true }));
  const args = createArgs();
  assert.equal(await creds.create(args), "native-create");
  assert.equal(win.native.create[0], args);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "create");
  assert.equal(seen[0].options.challenge, b64u("challenge-1234567"));
  assert.deepEqual(seen[0].options.exclude, [b64u("old")]);
  assert.deepEqual(seen[0].options.algs, [-7]);
});

test("page script: Notiq's credential is shaped like a PublicKeyCredential", async () => {
  const win = fakeWindow();
  const creds = loadPage(win);
  const cd = b64u('{"type":"webauthn.create"}');
  fakeBridge(win, () => ({ ok: true, credential: { credentialId: b64u("cred"), clientDataJSON: cd, attestationObject: b64u("att"),
    authenticatorData: b64u("auth"), publicKey: b64u("spki"), alg: -7, credProps: true } }));
  const c = await creds.create(createArgs({ extensions: { credProps: true } }));
  assert.ok(c instanceof win.PublicKeyCredential);
  assert.ok(c.response instanceof win.AuthenticatorAttestationResponse);
  assert.equal(c.id, b64u("cred"));
  assert.equal(c.type, "public-key");
  assert.equal(Buffer.from(c.rawId).toString(), "cred");
  assert.equal(Buffer.from(c.response.clientDataJSON).toString(), '{"type":"webauthn.create"}');
  assert.equal(Buffer.from(c.response.attestationObject).toString(), "att");
  assert.equal(Buffer.from(c.response.getAuthenticatorData()).toString(), "auth");
  assert.equal(Buffer.from(c.response.getPublicKey()).toString(), "spki");
  assert.equal(c.response.getPublicKeyAlgorithm(), -7);
  assert.deepEqual(plain(c.getClientExtensionResults()), { credProps: { rk: true } });
  assert.equal(c.toJSON().response.attestationObject, b64u("att"));
  assert.equal(win.native.create.length, 0);
});

test("page script: assertions and the excluded error", async () => {
  const win = fakeWindow();
  const creds = loadPage(win);
  fakeBridge(win, (d) => (d.kind === "get"
    ? { ok: true, credential: { credentialId: "YQ", clientDataJSON: "e30", authenticatorData: "AAAA", signature: "MEUC", userHandle: b64u("user-1") } }
    : { error: "excluded" }));
  const a = await creds.get({ publicKey: { challenge: bytes("abc"), rpId: "github.com", allowCredentials: [{ type: "public-key", id: bytes("a") }] } });
  assert.ok(a.response instanceof win.AuthenticatorAssertionResponse);
  assert.equal(Buffer.from(a.response.userHandle).toString(), "user-1");
  await assert.rejects(creds.create(createArgs()), (e) => e.name === "InvalidStateError");
  assert.equal(win.native.create.length, 0, "an excluded credential does not fall back");
});

test("page script: abort rejects without asking the browser", async () => {
  const win = fakeWindow();
  const creds = loadPage(win);
  fakeBridge(win, () => null); // never answers
  const ac = new AbortController();
  const p = creds.get({ publicKey: { challenge: bytes("abc") }, signal: ac.signal });
  await sleep(5);
  ac.abort();
  await assert.rejects(p, (e) => e.name === "AbortError");
  assert.equal(win.native.get.length, 0);
});

test("page script: answers from other frames or origins are ignored", async () => {
  const win = fakeWindow();
  const creds = loadPage(win);
  let id;
  fakeBridge(win, (d) => { id = d.id; return null; });
  const p = creds.get({ publicKey: { challenge: bytes("abc") } });
  await sleep(5);
  win.inject({ tag: "notiq-passkey", dir: "res", id, ok: true, credential: {} });
  win.inject({ tag: "notiq-passkey", dir: "res", id, fallback: true }, { source: win.self, origin: "https://evil.com" });
  const r = await Promise.race([p, sleep(30).then(() => "pending")]);
  assert.equal(r, "pending");
});

// ---------- passkey-bridge.js ----------
function loadBridge(win, reply) {
  const sent = [];
  win.chrome = { runtime: { lastError: undefined, sendMessage: (msg, cb) => { sent.push(msg); setTimeout(() => cb(reply(msg)), 0); } } };
  const c = vm.createContext(win);
  win.self = vm.runInContext("globalThis", c);
  vm.runInContext(read("passkey-bridge.js"), c);
  return sent;
}
function answers(win) {
  const got = [];
  win.addEventListener("message", (e) => { if (e.data && e.data.dir === "res") got.push(e.data); });
  return got;
}
const req = (over = {}) => ({ tag: "notiq-passkey", dir: "req", id: "get-abc123", kind: "get", options: { challenge: "AAAA" }, ...over });

test("bridge: forwards a request made right after a user gesture and returns the answer", async () => {
  const win = fakeWindow();
  const sent = loadBridge(win, () => ({ ok: true, credential: { credentialId: "YQ" }, extra: "dropped" }));
  const got = answers(win);
  win.postMessage(req(), win.location.origin);
  await sleep(60);
  assert.deepEqual(sent.map(plain), [{ type: "passkey", kind: "get", options: { challenge: "AAAA" }, ancestors: [] }]);
  assert.deepEqual(got.map(plain), [{ ok: true, credential: { credentialId: "YQ" }, tag: "notiq-passkey", dir: "res", id: "get-abc123" }]);
});

test("bridge: no user gesture, bad shapes or other frames never reach the background", async () => {
  const idle = fakeWindow({ active: false });
  const sentIdle = loadBridge(idle, () => ({ ok: true }));
  const gotIdle = answers(idle);
  idle.postMessage(req(), idle.location.origin);
  await sleep(60);
  assert.equal(sentIdle.length, 0);
  assert.deepEqual(gotIdle.map((d) => d.fallback), [true]);

  const win = fakeWindow();
  const sent = loadBridge(win, () => ({ ok: true }));
  const got = answers(win);
  for (const bad of [req({ kind: "delete", id: "delete-1" }), req({ id: "create-1" }), req({ options: null }),
    req({ options: { big: "x".repeat(40000) } })]) win.postMessage(bad, win.location.origin);
  win.postMessage(req({ id: "bad id" }), win.location.origin); // ignored entirely
  win.inject(req({ id: "get-other" })); // another frame
  await sleep(60);
  assert.equal(sent.length, 0);
  assert.equal(got.length, 3, "the request with a malformed id is ignored entirely");
  assert.ok(got.every((d) => d.fallback === true));
});

test("bridge: only `excluded` is passed on as an error; everything else falls back", async () => {
  const win = fakeWindow();
  loadBridge(win, () => ({ error: "excluded" })); // for a get, `excluded` means nothing: fall back
  const got = answers(win);
  win.postMessage(req({ id: "create-1", kind: "create" }), win.location.origin);
  win.postMessage(req({ id: "get-1" }), win.location.origin);
  await sleep(60);
  assert.deepEqual(got.map((d) => [d.id, d.error || (d.fallback && "fallback")]).sort(), [["create-1", "excluded"], ["get-1", "fallback"]]);
});
