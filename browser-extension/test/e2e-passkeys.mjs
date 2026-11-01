// End-to-end check of the experimental passkey support in a real Chromium (developer check, not packaged).
//
//   node browser-extension/test/e2e-passkeys.mjs
//
// Same setup as e2e-cdp.mjs: `python -m http.server` for browser-extension/, Playwright's Chromium (or
// NOTIQ_CHROME) with the unpacked extension, the native host mocked in the service worker (the real Notiq app,
// its approval prompt and its Rust signing are NOT involved: the mock answers with fixed bytes). A CDP virtual
// authenticator stands in for the browser's own passkey dialog, so the fallback path can be seen working.
// Checks: the setting registers / removes the MAIN-world script and its bridge, the page's create/get reach the
// app with the frame's real origin and a client data the extension built, results come back as
// PublicKeyCredentials, and refusals, a missing user gesture or Notiq being closed fall back to the browser.
// Headless Chromium can't answer the optional-host-access prompt the popup switch shows, so the extension is
// loaded from a temporary copy whose manifest grants that access up front (the prompt itself is NOT exercised;
// so is giving the access back, which a required permission can't do).
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8765 + Math.floor(Math.random() * 500);
const CDP_PORT = 9400 + Math.floor(Math.random() * 500);
const PAGE = `http://localhost:${PORT}/test-pages/passkey.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.NOTIQ_CHROME) return process.env.NOTIQ_CHROME;
  const base = join(process.env.LOCALAPPDATA || "", "ms-playwright");
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) for (const sub of ["chrome-win64", "chrome-win"]) {
    const p = join(base, d, sub, "chrome.exe");
    if (existsSync(p)) return p;
  }
  throw new Error("No Chromium found; set NOTIQ_CHROME");
}

let ws, nextId = 0;
const waiting = new Map();
function cdp(method, params = {}, sessionId) {
  return new Promise((res, rej) => {
    const id = ++nextId;
    waiting.set(id, { res, rej, method });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function connect(url) {
  ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      if (m.error) w.rej(new Error(`${w.method}: ${m.error.message}`)); else w.res(m.result);
    }
  };
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -> ${detail}` : ""}`);
}

let page, sw;
const evalIn = async (session, expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
  if (r.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)}`);
  return r.result.value;
};
const P = (expr) => evalIn(page, expr);
const SW = (expr) => evalIn(sw, expr);

async function mockNative(replies) {
  await SW(`(() => {
    globalThis.__calls = [];
    globalThis.__reply = ${JSON.stringify(replies)};
    const fake = (host, msg, cb) => {
      globalThis.__calls.push(JSON.parse(JSON.stringify(msg)));
      const r = globalThis.__reply[msg.op] || { error: "app_not_running" };
      setTimeout(() => cb(JSON.parse(JSON.stringify(r))), 200);
    };
    try { chrome.runtime.sendNativeMessage = fake; } catch {}
    if (chrome.runtime.sendNativeMessage !== fake) Object.defineProperty(chrome.runtime, "sendNativeMessage", { value: fake, configurable: true, writable: true });
    return true;
  })()`);
}
const passkeyCalls = async () => (await SW("globalThis.__calls || []")).filter((c) => String(c.op).startsWith("passkey"));
const registered = () => SW(`chrome.scripting.getRegisteredContentScripts().then((l) => l.map((s) => ({ id: s.id, world: s.world || "ISOLATED", runAt: s.runAt, allFrames: s.allFrames, matches: s.matches })))`);

async function load(url = PAGE) {
  await cdp("Page.navigate", { url }, page);
  for (let i = 0; i < 50; i++) { await sleep(100); if ((await P("document.readyState").catch(() => "")) === "complete") break; }
  await sleep(300);
}
async function clickId(id) {
  const r = await P(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; })()`);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y }, page);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 }, page);
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 }, page);
}
async function result(ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await P("window.__result || null");
    if (r) return r;
    await sleep(100);
  }
  return null;
}
const reset = () => P("(window.__result = null, true)");
const b64uText = (s) => Buffer.from(s, "base64url").toString();

const CRED = Buffer.from("notiq-credential-1").toString("base64url");
const NATIVE = {
  ping: { ok: true },
  passkey_create: { ok: true, credentialId: CRED, attestationObject: Buffer.from("att-object").toString("base64url"),
    authenticatorData: Buffer.from("auth-data").toString("base64url"), publicKey: Buffer.from("spki").toString("base64url"), alg: -7 },
  passkey_get: { ok: true, credentialId: CRED, authenticatorData: Buffer.from("auth-data").toString("base64url"),
    signature: Buffer.from("sig").toString("base64url"), userHandle: Buffer.from("tester@example.com").toString("base64url") },
};

// The temporary copy: optional host access made required (granted at load), tests and pages left out.
const EXT_COPY = mkdtempSync(join(tmpdir(), "notiq-ext-pk-copy-"));
cpSync(EXT, EXT_COPY, { recursive: true, filter: (src) => !/[\/](test|test-pages|store|dist)([\/]|$)/.test(src.slice(EXT.length)) });
{
  const m = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
  m.host_permissions = m.optional_host_permissions;
  delete m.optional_host_permissions;
  writeFileSync(join(EXT_COPY, "manifest.json"), JSON.stringify(m, null, 2));
}
const server = spawn("python", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", EXT], { stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "notiq-ext-pk-"));
const chrome = spawn(findChrome(), [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--headless=new",
  `--disable-extensions-except=${EXT_COPY}`, `--load-extension=${EXT_COPY}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1200,900", "about:blank",
], { stdio: "ignore" });

let exitCode = 1;
try {
  let ver;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(250); ver = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json()).catch(() => null); }
  if (!ver) throw new Error("Chromium did not start");
  await connect(ver.webSocketDebuggerUrl);
  let swTarget;
  for (let i = 0; i < 40 && !swTarget; i++) {
    const { targetInfos } = await cdp("Target.getTargets");
    swTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"));
    if (!swTarget) await sleep(250);
  }
  if (!swTarget) throw new Error("Extension service worker not found");
  ({ sessionId: sw } = await cdp("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true }));
  await cdp("Runtime.enable", {}, sw);
  await mockNative(NATIVE);

  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  ({ sessionId: page } = await cdp("Target.attachToTarget", { targetId, flatten: true }));
  for (const d of ["Page.enable", "Runtime.enable"]) await cdp(d, {}, page);
  await cdp("Target.activateTarget", { targetId });
  // The browser's own passkey implementation for the fallback path.
  await cdp("WebAuthn.enable", { enableUI: false }, page);
  await cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "usb", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }, page);

  // ---- off by default: nothing registered, the page's API untouched ----
  check("off by default: no passkey scripts registered", (await registered()).length === 0, JSON.stringify(await registered()));
  await load();
  check("off: navigator.credentials is the browser's own", (await P("String(CredentialsContainer.prototype.create)")).includes("[native code]"));

  // ---- turn it on from the popup (a real click: the host access is requested from that gesture) ----
  const extId = new URL(swTarget.url).host;
  const { targetId: popTarget } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId: pop } = await cdp("Target.attachToTarget", { targetId: popTarget, flatten: true });
  await cdp("Runtime.enable", {}, pop);
  await sleep(800);
  const togglePasskeys = async () => {
    await cdp("Target.activateTarget", { targetId: popTarget });
    const at = await evalIn(pop, `(() => { const e = document.getElementById("passkeys"); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, pop);
    await sleep(800);
    await cdp("Target.activateTarget", { targetId });
  };
  check("popup: the passkey switch is off by default", (await evalIn(pop, "document.getElementById('passkeys').checked")) === false);
  await togglePasskeys();
  check("popup: switching it on (host access present) stores the setting",
    (await SW(`chrome.permissions.contains({ origins: ["https://*/*", "http://localhost/*"] })`)) === true
      && (await SW("chrome.storage.local.get('passkeys')")).passkeys === true,
    JSON.stringify([await evalIn(pop, "document.getElementById('passkeys').checked"), await SW("chrome.storage.local.get(null)"), await SW("chrome.permissions.getAll()")]));
  let reg = [];
  for (let i = 0; i < 30 && reg.length < 2; i++) { await sleep(100); reg = await registered(); }
  const page_ = reg.find((s) => s.id === "notiq-passkey-page");
  const bridge = reg.find((s) => s.id === "notiq-passkey-bridge");
  check("on: MAIN-world page script and isolated bridge registered at document_start in all frames",
    page_ && bridge && page_.world === "MAIN" && bridge.world === "ISOLATED" && page_.runAt === "document_start" && page_.allFrames === true
      && JSON.stringify([...page_.matches].sort()) === JSON.stringify(["http://localhost/*", "https://*/*"]), JSON.stringify(reg));

  await load();
  check("on: navigator.credentials.create is wrapped", !(await P("String(CredentialsContainer.prototype.create)")).includes("[native code]"));

  // ---- create through Notiq ----
  await mockNative(NATIVE);
  await reset();
  await clickId("create");
  let r = await result();
  let calls = await passkeyCalls();
  const c0 = calls[0] || {};
  const cd0 = c0.clientDataJSON ? JSON.parse(b64uText(c0.clientDataJSON)) : {};
  check("create: the app gets origin, RP ID = host, user and ES256", c0.op === "passkey_create" && c0.origin === `http://localhost:${PORT}`
    && c0.rpId === "localhost" && c0.user && c0.user.name === "tester@example.com" && c0.algs.includes(-7) && typeof c0.ext === "string", JSON.stringify(c0));
  check("create: the extension built the client data from the real origin", cd0.type === "webauthn.create" && cd0.origin === `http://localhost:${PORT}`
    && cd0.crossOrigin === false && typeof cd0.challenge === "string" && cd0.challenge.length === 43, JSON.stringify(cd0));
  check("create: the page gets a PublicKeyCredential with Notiq's credential", r && r.id === CRED && r.isPkc === true && r.type === "public-key"
    && r.attachment === "platform" && r.publicKeyAlgorithm === -7 && r.attestationObject === NATIVE.passkey_create.attestationObject
    && r.clientData === b64uText(c0.clientDataJSON || ""), JSON.stringify(r));

  // ---- get through Notiq ----
  await mockNative(NATIVE);
  await reset();
  await clickId("getAllowed");
  r = await result();
  calls = await passkeyCalls();
  const g0 = calls[0] || {};
  check("get: the app gets the RP ID and the allow list", g0.op === "passkey_get" && g0.rpId === "localhost" && JSON.stringify(g0.allow) === JSON.stringify([CRED]), JSON.stringify(g0));
  check("get: the page gets the assertion", r && r.id === CRED && r.isPkc && r.signature === NATIVE.passkey_get.signature
    && r.userHandle === NATIVE.passkey_get.userHandle && JSON.parse(r.clientData).type === "webauthn.get", JSON.stringify(r));

  // ---- refusals fall back to the browser (the virtual authenticator answers) ----
  await mockNative({ ...NATIVE, passkey_create: { error: "denied" } });
  await reset();
  await clickId("create");
  r = await result(10000);
  check("declined in Notiq: the browser's own passkey dialog creates it", r && r.id && r.id !== CRED && r.isPkc && (await passkeyCalls()).length === 1, JSON.stringify(r));

  await mockNative({ ...NATIVE, passkey_get: { error: "app_not_running" } });
  await reset();
  await clickId("get");
  r = await result(10000);
  check("Notiq not running: the browser signs in instead", r && r.id && r.id !== CRED && !r.error, JSON.stringify(r));

  await mockNative({ ...NATIVE, passkey_create: { error: "excluded" } });
  await reset();
  await clickId("create");
  r = await result();
  check("excluded credential: InvalidStateError, no fallback", r && r.error === "InvalidStateError", JSON.stringify(r));

  // ---- no user gesture: Notiq is never asked ----
  await mockNative(NATIVE);
  await reset();
  await sleep(5500); // let the last click's transient activation expire
  await P("(window.__create(), true)"); // Runtime.evaluate without userGesture
  r = await result(10000);
  check("no user gesture: Notiq is not asked, the browser handles it", (await passkeyCalls()).length === 0 && r && r.id !== CRED, JSON.stringify(r));

  // ---- switched off in the popup: setting and host access dropped, scripts removed ----
  await togglePasskeys();
  for (let i = 0; i < 30 && (await registered()).length; i++) await sleep(100);
  check("off again: setting cleared, scripts removed", (await registered()).length === 0
    && (await SW("chrome.storage.local.get('passkeys')")).passkeys === false);
  // The already-loaded page still has the wrapper, but the background refuses: fallback.
  await mockNative(NATIVE);
  await reset();
  await clickId("create");
  r = await result(10000);
  check("off again: an open page is refused by the background (browser dialog)", (await passkeyCalls()).length === 0 && r && r.id !== CRED, JSON.stringify(r));
  await load();
  check("off again: a reloaded page has the browser's own API", (await P("String(CredentialsContainer.prototype.create)")).includes("[native code]"));

  exitCode = results.every((x) => x.ok) ? 0 : 1;
} catch (e) {
  console.error("ERROR", e && e.stack || e);
} finally {
  try { ws && ws.close(); } catch {}
  chrome.kill();
  server.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(EXT_COPY, { recursive: true, force: true }); } catch {}
  console.log(`\n${results.filter((x) => x.ok).length}/${results.length} checks passed`);
  process.exit(exitCode);
}
