// End-to-end check of the unpacked extension in a real Chromium, driven over the
// DevTools protocol with no npm dependencies (Node 22+ has a built-in WebSocket).
// Not part of the packaged extension logic.
//
//   node browser-extension/test/e2e-cdp.mjs
//
// It starts `python -m http.server` on 127.0.0.1 for browser-extension/, launches
// Chromium (Playwright's copy under %LOCALAPPDATA%\ms-playwright, or NOTIQ_CHROME)
// with the extension loaded, replaces chrome.runtime.sendNativeMessage in the
// service worker with a recorder/mock (the real Notiq app is not involved), and
// uses CDP Input events — which the page sees as trusted user input — to click and
// type. Synthetic DOM events are used for the "untrusted" cases.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8765 + Math.floor(Math.random() * 500);
const CDP_PORT = 9400 + Math.floor(Math.random() * 500);
const PAGE = `http://localhost:${PORT}/test-pages/login.html`;
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

// ---------- tiny CDP client ----------
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

// ---------- results ----------
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

// Installs a recorder + mock for the native host in the service worker.
async function mockNative(replies) {
  await SW(`(() => {
    globalThis.__calls = globalThis.__calls || [];
    globalThis.__reply = ${JSON.stringify(replies)};
    const fake = (host, msg, cb) => {
      globalThis.__calls.push(JSON.parse(JSON.stringify(msg)));
      let r = globalThis.__reply[msg.op] || { error: "app_not_running" };
      // { ..., withAccount: {...} }: a different reply when the request names an account.
      if (r.withAccount) { if (msg.account) r = r.withAccount; else { r = { ...r }; delete r.withAccount; } }
      setTimeout(() => cb(JSON.parse(JSON.stringify(r))), 300);
    };
    try { chrome.runtime.sendNativeMessage = fake; } catch {}
    if (chrome.runtime.sendNativeMessage !== fake) Object.defineProperty(chrome.runtime, "sendNativeMessage", { value: fake, configurable: true, writable: true });
    return chrome.runtime.sendNativeMessage === fake;
  })()`);
}
// Vault traffic only: the content-free {op:"theme"} refresh is checked separately (allCalls).
const allCalls = () => SW("globalThis.__calls || []");
// Every request carries the extension's version and protocol (handshake); `bare` strips them for contract checks.
const bare = (c) => { const { ext, protocol, ...rest } = c; return rest; };
const tagged = (c) => typeof c.ext === "string" && c.ext.length > 0 && c.protocol === 2;
// Vault requests only (theme, the lock-state ping and the password-reuse check, which carries no secret, are not).
const REUSE_OPS = ["reuse_salt", "reuse_check"];
const calls = async () => (await allCalls()).filter((c) => c.op !== "theme" && c.op !== "ping" && !REUSE_OPS.includes(c.op));
const reuseCalls = async () => (await allCalls()).filter((c) => REUSE_OPS.includes(c.op));
const pings = async () => (await allCalls()).filter((c) => c.op === "ping");
const resetCalls = () => SW("(globalThis.__calls = [], true)");
const session = () => SW("chrome.storage.session.get(null)");
const local = () => SW("chrome.storage.local.get(null)");
const pendingEntries = async () => Object.entries(await session()).filter(([k]) => k.startsWith("pending:")).map(([, v]) => v);

// The closed shadow root, reached through CDP (DOM.getDocument pierces closed roots).
async function shadowObj() {
  const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true }, page);
  const html = root.children.find((n) => n.nodeName === "HTML");
  const host = (html.children || []).find((n) => n.nodeName === "DIV" && n.shadowRoots && n.shadowRoots.length);
  if (!host) return null;
  const sr = host.shadowRoots[0];
  const { object } = await cdp("DOM.resolveNode", { nodeId: sr.nodeId }, page);
  return { object, mode: sr.shadowRootType };
}
async function inShadow(fn) {
  const s = await shadowObj();
  if (!s) return null;
  const r = await cdp("Runtime.callFunctionOn", { objectId: s.object.objectId, functionDeclaration: fn, returnByValue: true, awaitPromise: true }, page);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
}
const icons = () => inShadow(`function () {
  return [...this.querySelectorAll(".nq-wrap")].map((w) => {
    const r = w.querySelector(".nq-icon").getBoundingClientRect();
    return { cls: w.className, tip: w.querySelector(".nq-tip").textContent, x: r.x + r.width / 2, y: r.y + r.height / 2, display: w.style.display };
  });
}`);
const barInfo = () => inShadow(`function () {
  const b = this.querySelector(".nq-bar:not(.out)");
  if (!b) return null;
  return { text: b.textContent, role: b.getAttribute("role"), live: b.getAttribute("aria-live"),
    buttons: [...b.querySelectorAll("button")].map((x) => { const r = x.getBoundingClientRect(); return { label: x.textContent, x: r.x + r.width / 2, y: r.y + r.height / 2 }; }) };
}`);

// Every closed overlay root, in the top document and in same-process iframes.
async function allShadows() {
  const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true }, page);
  const out = [];
  const idOf = (n) => { const a = n.attributes || []; const k = a.indexOf("id"); return k >= 0 ? a[k + 1] : ""; };
  const walk = (n, frame) => {
    if (n.nodeName === "HTML") {
      for (const c of n.children || []) if (c.nodeName === "DIV" && c.shadowRoots && c.shadowRoots.length) out.push({ frame, sr: c.shadowRoots[0] });
    }
    for (const c of n.children || []) walk(c, frame);
    if (n.contentDocument) walk(n.contentDocument, idOf(n));
  };
  walk(root, "");
  return out;
}
async function inFrameShadow(frame, fn) {
  const s = (await allShadows()).find((x) => x.frame === frame);
  if (!s) return null;
  const { object } = await cdp("DOM.resolveNode", { nodeId: s.sr.nodeId }, page);
  const r = await cdp("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: fn, returnByValue: true, awaitPromise: true }, page);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return { mode: s.sr.shadowRootType, value: r.result.value };
}
// The open menu (generator / chooser), with item centres in page coordinates.
const menuInfo = () => inShadow(`function () {
  const m = this.querySelector(".nq-menu");
  if (!m) return null;
  return { role: m.getAttribute("role"), label: m.getAttribute("aria-label"), text: m.textContent,
    imgs: m.querySelectorAll("img").length, active: this.activeElement ? this.activeElement.textContent : null,
    items: [...m.querySelectorAll(".nq-item")].map((x) => { const r = x.getBoundingClientRect(); return { label: x.querySelector(".nq-ititle").textContent, role: x.getAttribute("role"), x: r.x + r.width / 2, y: r.y + r.height / 2 }; }) };
}`);
// The icon inside a top-document field, by the field's id.
async function iconFor(id) {
  const f = await P(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.scrollIntoView({block:"center"}); const r = e.getBoundingClientRect(); return { right: r.right, cy: r.y + r.height / 2 }; })()`);
  await sleep(250);
  const list = (await icons()) || [];
  return list.find((i) => Math.abs(i.y - f.cy) < 3 && i.x < f.right && i.x > f.right - 30) || null;
}
async function key(k, code, vk) {
  const d = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...d, ...(k === "Enter" ? { text: "\r" } : {}) }, page);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...d }, page);
}

async function mouseClick(x, y) {
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, page);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, page);
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, page);
}
async function clickId(id) {
  const r = await P(`(() => { document.getElementById(${JSON.stringify(id)}).scrollIntoView({block:"center"}); const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
  await mouseClick(r.x, r.y);
}
async function typeInto(id, text) {
  await clickId(id);
  await P(`document.getElementById(${JSON.stringify(id)}).select()`);
  await cdp("Input.insertText", { text }, page);
}
async function pressEnter() {
  const k = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...k, text: "\r" }, page);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...k }, page);
}
async function load(url = PAGE) {
  await cdp("Page.navigate", { url }, page);
  for (let i = 0; i < 50; i++) { await sleep(100); if ((await P("document.readyState").catch(() => "")) === "complete") break; }
  await sleep(900); // document_idle + settings read + scan
}
async function resetState(settings = {}) {
  await SW(`chrome.storage.session.clear().then(() => chrome.storage.local.clear()).then(() => chrome.storage.local.set(${JSON.stringify({ suggestOnFocus: true, ...settings })})).then(() => true)`); // the suggestion is off by default; most checks need it on
  await resetCalls();
}
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); }
  return v;
}

// ---------- run ----------
const server = spawn("python", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", EXT], { stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "notiq-ext-e2e-"));
const chrome = spawn(findChrome(), [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--headless=new",
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
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
  if (!swTarget) throw new Error("Extension service worker not found (was the extension loaded?)");
  ({ sessionId: sw } = await cdp("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true }));
  await cdp("Runtime.enable", {}, sw);
  const manifest = await SW("chrome.runtime.getManifest()");
  check("manifest version 0.7.0 with storage permission and all-frames content script (same-site gated)",
    manifest.version === "0.7.0" && manifest.permissions.includes("storage") && manifest.content_scripts[0].all_frames === true &&
    typeof manifest.key === "string" && manifest.key.length > 100);

  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  ({ sessionId: page } = await cdp("Target.attachToTarget", { targetId, flatten: true }));
  for (const d of ["Page.enable", "DOM.enable", "Runtime.enable"]) await cdp(d, {}, page);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }, page);

  const NATIVE = { fill: { ok: true, username: "alice@example.com", password: "Notiq-Filled-1!", title: "Test" }, save: { ok: true, status: "saved" }, ping: { ok: true } };
  await mockNative(NATIVE);

  // 1. Detection + closed shadow root + no request on load
  await resetState();
  await load();
  const s0 = await shadowObj();
  check("overlay lives in a closed shadow root", s0 && s0.mode === "closed");
  check("page JS cannot see into the overlay", await P(`[...document.documentElement.children].filter(e => e.tagName === "DIV").every(d => d.shadowRoot === null)`));
  let ic = await icons();
  // simple: email + password; twostep: username (username-first on /login path); signup: email + 2 passwords
  check("detects login fields (simple 2 + two-step username 1 + signup 3 = 6 icons)", ic && ic.length === 6, JSON.stringify(ic && ic.length));
  check("nothing sent to Notiq on page load", (await calls()).length === 0);

  // 2. Untrusted click on the icon does nothing
  await inShadow(`function () { this.querySelector(".nq-icon").click(); this.querySelector(".nq-icon").dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })); }`);
  await sleep(800);
  ic = await icons();
  check("synthetic (untrusted) icon click is ignored", (await calls()).length === 0 && ic.every((i) => !/waiting|error|done/.test(i.cls)));

  // 3. Trusted click on the password icon fills via the background
  const pwIconPos = await P(`(() => { const r = document.getElementById("s-pass").getBoundingClientRect(); return { right: r.right, cy: r.y + r.height / 2 }; })()`);
  ic = await icons();
  const pwIcon = ic.find((i) => Math.abs(i.y - pwIconPos.cy) < 3 && i.x < pwIconPos.right && i.x > pwIconPos.right - 30);
  check("icon sits at the right inside edge of the field", !!pwIcon, JSON.stringify({ pwIconPos, ic }));
  await mouseClick(pwIcon.x, pwIcon.y);
  const waitingSeen = await waitFor(async () => (await icons()).some((i) => i.cls.includes("waiting") && i.tip === "Approve in Notiq"), 1000);
  check("icon shows waiting state 'Approve in Notiq'", waitingSeen);
  await waitFor(async () => (await icons()).some((i) => i.cls.includes("done")), 3000);
  const c1 = await calls();
  check("trusted click sends exactly one fill request with the page host", c1.length === 1 && c1[0].op === "fill" && c1[0].host === "localhost", JSON.stringify(c1));
  const vals = await P(`({ u: document.getElementById("s-user").value, p: document.getElementById("s-pass").value })`);
  check("fills username and password into the page", vals.u === "alice@example.com" && vals.p === "Notiq-Filled-1!", JSON.stringify(vals));

  // 4. Submitting what Notiq just filled does not offer to save
  await clickId("s-pass");
  await pressEnter();
  await sleep(2500);
  check("no save offer for values Notiq just filled", (await pendingEntries()).length === 0 && !(await barInfo()));

  // 5. New login typed by the user -> capture -> bar -> save
  await resetState();
  await load();
  await typeInto("s-user", "bob@example.com");
  await typeInto("s-pass", "Typed-Secret-2!");
  await P(`document.querySelector("#simple button[type=submit]").scrollIntoView({block:"center"})`);
  const sb = await P(`(() => { const r = document.querySelector("#simple button[type=submit]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await mouseClick(sb.x, sb.y);
  const pend = await waitFor(async () => (await pendingEntries())[0], 2000);
  check("capture stored in storage.session with the right shape",
    pend && pend.host === "localhost" && pend.url === `http://localhost:${PORT}/test-pages/login.html` &&
    pend.username === "bob@example.com" && pend.password === "Typed-Secret-2!" && pend.title === "Notiq test page: login forms" && typeof pend.at === "number",
    JSON.stringify(pend && { ...pend, password: "<redacted>" }));
  const loc = JSON.stringify(await local());
  check("password never written to storage.local", !loc.includes("Typed-Secret-2!"));
  check("still nothing sent to Notiq before the user says Save", (await calls()).length === 0);
  const bar = await waitFor(barInfo, 4000);
  check("save bar shown once the password field is gone", bar && bar.text.includes("Save login to Notiq?") && bar.text.includes("localhost · bob@example.com"), JSON.stringify(bar));
  check("save bar is a polite dialog and shows no password", bar && bar.role === "dialog" && bar.live === "polite" && !bar.text.includes("Typed-Secret-2!"));
  check("page DOM never contains the password", !(await P(`document.documentElement.outerHTML.includes("Typed-Secret-2!")`)));
  // untrusted click on Save does nothing
  await inShadow(`function () { this.querySelector(".nq-bar .nq-primary").click(); }`);
  await sleep(600);
  check("synthetic click on Save is ignored", (await calls()).length === 0);
  const saveBtn = bar.buttons.find((b) => b.label === "Save");
  await mouseClick(saveBtn.x, saveBtn.y);
  const w = await waitFor(async () => { const b = await barInfo(); return b && b.text.includes("Waiting for approval in Notiq…") && b; }, 1000);
  check("bar shows 'Waiting for approval in Notiq…'", !!w);
  const done = await waitFor(async () => { const b = await barInfo(); return b && b.text.includes("Saved to Notiq") && b; }, 3000);
  check("bar shows 'Saved to Notiq' after the app approves", !!done);
  const c2 = await calls();
  check("native save message matches the contract",
    c2.length === 1 && c2[0].op === "save" && c2[0].host === "localhost" && c2[0].url === `http://localhost:${PORT}/test-pages/login.html` &&
    c2[0].username === "bob@example.com" && c2[0].password === "Typed-Secret-2!" && c2[0].title === "Notiq test page: login forms" &&
    tagged(c2[0]) && Object.keys(bare(c2[0])).sort().join() === "host,op,password,title,url,username", JSON.stringify(c2.map((c) => ({ ...c, password: "<redacted>" }))));
  check("pending capture deleted after save", (await pendingEntries()).length === 0);

  // 6. Error path: locked vault keeps the capture and offers Try again
  await resetState();
  await mockNative({ ...NATIVE, save: { error: "locked" } });
  await load();
  await typeInto("s-user", "carol@example.com");
  await typeInto("s-pass", "Another-Pw-3");
  await pressEnter();
  const bar6 = await waitFor(barInfo, 4500);
  await mouseClick(bar6.buttons[0].x, bar6.buttons[0].y);
  const err = await waitFor(async () => { const b = await barInfo(); return b && b.text.includes("The vault is locked") && b; }, 3000);
  check("locked -> human error and 'Try again'", err && err.buttons.some((b) => b.label === "Try again"), JSON.stringify(err));
  check("capture kept for retry after a retryable error", (await pendingEntries()).length === 1);
  // Esc dismisses (trusted key) and clears the capture
  const esc = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...esc }, page);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...esc }, page);
  await sleep(500);
  check("Esc closes the bar and drops the capture", !(await barInfo()) && (await pendingEntries()).length === 0);
  await mockNative(NATIVE);

  // 7. Two-step: username remembered from step 1
  await resetState();
  await load();
  await typeInto("t-user", "dave");
  await clickId("t-next");
  await sleep(300);
  await typeInto("t-pass", "TwoStep-Pw-4");
  await pressEnter();
  const p7 = await waitFor(async () => (await pendingEntries())[0], 2000);
  check("two-step flow: username from step 1 is used", p7 && p7.username === "dave" && p7.password === "TwoStep-Pw-4", JSON.stringify(p7 && p7.username));

  // 8. Sign-up with new-password: email is the username, new password captured
  await resetState();
  await load();
  await typeInto("u-name", "Erin Example");
  await typeInto("u-email", "erin@example.com");
  await typeInto("u-pass", "Brand-New-5");
  await typeInto("u-pass2", "Brand-New-5");
  await P(`document.querySelector("#signup button").scrollIntoView({block:"center"})`);
  const sg = await P(`(() => { const r = document.querySelector("#signup button").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await mouseClick(sg.x, sg.y);
  const p8 = await waitFor(async () => (await pendingEntries())[0], 2000);
  check("sign-up form captured (email + new password)", p8 && p8.username === "erin@example.com" && p8.password === "Brand-New-5", JSON.stringify(p8 && p8.username));
  // Never for this site
  const bar8 = await waitFor(barInfo, 4500);
  const never = bar8 && bar8.buttons.find((b) => b.label === "Never for this site");
  await mouseClick(never.x, never.y);
  await sleep(600);
  const l8 = await local();
  check("'Never for this site' adds host to neverSave and drops capture", Array.isArray(l8.neverSave) && l8.neverSave.includes("localhost") && (await pendingEntries()).length === 0, JSON.stringify(l8));

  // 9. neverSave host: no capture
  await resetCalls();
  await load();
  await typeInto("s-user", "frank@example.com");
  await typeInto("s-pass", "Never-Pw-6");
  await pressEnter();
  await sleep(1500);
  check("no capture for a host in neverSave", (await pendingEntries()).length === 0);

  // 10. offerSave off: no capture; showIcon off: no icons
  await resetState({ offerSave: false, showIcon: false });
  await load();
  check("showIcon=false hides all icons", ((await icons()) || []).length === 0);
  await SW(`chrome.storage.local.set({ showIcon: true }).then(() => true)`);
  check("settings change is picked up live (icons return)", await waitFor(async () => ((await icons()) || []).length > 0, 2000));
  await typeInto("s-user", "gina@example.com");
  await typeInto("s-pass", "Off-Pw-7");
  await pressEnter();
  await sleep(1500);
  check("offerSave=false: no capture", (await pendingEntries()).length === 0);

  // 11. Untrusted submit by page script: no capture
  await resetState();
  await load();
  await P(`(() => { document.getElementById("s-user").value = "mallory"; document.getElementById("s-pass").value = "Page-Set-8"; document.getElementById("simple").requestSubmit(); return true; })()`);
  await sleep(2000);
  check("page-script submit (untrusted) is not captured", (await pendingEntries()).length === 0 && !(await barInfo()));

  // 12. Empty password: no capture
  await load();
  await typeInto("s-user", "henry@example.com");
  await clickId("s-pass");
  await pressEnter();
  await sleep(1200);
  check("no capture without a password value", (await pendingEntries()).length === 0);

  // 13. Dynamically added field (SPA)
  await load();
  await P(`(() => { const f = document.createElement("form"); f.id = "dyn"; f.innerHTML = '<input name="login" style="width:240px;height:30px"><input type="password" id="dynpw" style="width:240px;height:30px">'; document.querySelector("main").prepend(f); return true; })()`);
  const n13 = await waitFor(async () => ((await icons()) || []).length === 8, 2000);
  check("icons added for dynamically inserted login fields", n13);
  await P(`document.getElementById("dyn").remove()`);
  const n13b = await waitFor(async () => ((await icons()) || []).length === 6, 2000);
  check("icons removed when fields disappear", n13b);

  // 14. Message validation in the background (sent from an extension page opened in a tab)
  const extId = new URL(swTarget.url).host;
  const { targetId: popTarget } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId: pop } = await cdp("Target.attachToTarget", { targetId: popTarget, flatten: true });
  await cdp("Runtime.enable", {}, pop);
  await sleep(500);
  const sendFromPop = (m) => evalIn(pop, `new Promise((res) => chrome.runtime.sendMessage(${JSON.stringify(m)}, (r) => res(chrome.runtime.lastError ? "no-reply" : r)))`);
  await resetState();
  const extra = await sendFromPop({ type: "capture", payload: { host: "localhost", url: "", username: "", password: "x", title: "", evil: 1 } });
  check("capture with unexpected keys is rejected", extra && extra.error === "bad_request", JSON.stringify(extra));
  const big = await sendFromPop({ type: "capture", payload: { host: "localhost", url: "", username: "", password: "x".repeat(2000), title: "" } });
  check("oversized capture is rejected", big === "no-reply" || (big && big.error), JSON.stringify(big));
  const nonPage = await sendFromPop({ type: "capture", payload: { host: "localhost", url: "", username: "u", password: "pw", title: "" } });
  check("capture from a non-https/non-page sender is rejected", nonPage && nonPage.error === "not_https", JSON.stringify(nonPage));
  check("no pending entry was created by bad messages", (await pendingEntries()).length === 0);
  const unknown = await sendFromPop({ type: "whatever" });
  check("unknown message types get no handler", unknown === "no-reply", JSON.stringify(unknown));

  // ===================== 0.3.0 =====================
  await cdp("Target.activateTarget", { targetId });
  await sleep(300);
  const EXTRA = `http://localhost:${PORT}/test-pages/extra.html`;
  const LOOKALIKE = /[Il1O0o]/;

  // 15. Password generator on a sign-up form
  await resetState();
  await mockNative(NATIVE);
  await load();
  let gi = await iconFor("u-pass");
  await mouseClick(gi.x, gi.y);
  let m15 = await waitFor(menuInfo, 1500);
  check("new-password icon opens a role=menu with 'Generate strong password' only (sign-up: no 'Fill saved login')",
    m15 && m15.role === "menu" && m15.items.length === 1 && m15.items[0].label === "Generate strong password" && m15.items[0].role === "menuitem",
    JSON.stringify(m15));
  check("menu takes keyboard focus on its first item", m15 && m15.active && m15.active.startsWith("Generate strong password"), JSON.stringify(m15 && m15.active));
  check("opening the menu sends nothing to Notiq", (await calls()).length === 0);
  await key("Escape", "Escape", 27);
  await sleep(300);
  check("Esc closes the menu and returns focus to the field", !(await menuInfo()) && (await P(`document.activeElement && document.activeElement.id`)) === "u-pass");
  gi = await iconFor("u-pass");
  await mouseClick(gi.x, gi.y);
  m15 = await waitFor(menuInfo, 1500);
  await inShadow(`function () { this.querySelector(".nq-menu .nq-item").click(); }`);
  await sleep(300);
  check("synthetic click on 'Generate' is ignored", (await P(`document.getElementById("u-pass").value`)) === "");
  await mouseClick(m15.items[0].x, m15.items[0].y);
  await sleep(400);
  const gen = await P(`({ a: document.getElementById("u-pass").value, b: document.getElementById("u-pass2").value })`);
  check("generator fills the new-password AND confirm fields with the same value", gen.a && gen.a === gen.b, JSON.stringify({ la: gen.a.length, same: gen.a === gen.b }));
  check("generated password: 20 chars, upper+lower+digit+symbol, no look-alikes",
    gen.a.length === 20 && /[A-Z]/.test(gen.a) && /[a-z]/.test(gen.a) && /[0-9]/.test(gen.a) && /[^A-Za-z0-9]/.test(gen.a) && !LOOKALIKE.test(gen.a));
  const m15b = await menuInfo();
  check("menu confirms without showing the password", m15b && /Strong password filled in 2 fields/.test(m15b.text) && !m15b.text.includes(gen.a), JSON.stringify(m15b && m15b.text));
  check("nothing sent to Notiq / background before submit",
    (await calls()).length === 0 && (await pendingEntries()).length === 0 && !JSON.stringify(await local()).includes(gen.a));
  const showBtn = m15b.items.find((i) => i.label === "Show");
  await mouseClick(showBtn.x, showBtn.y);
  await sleep(250);
  const m15c = await menuInfo();
  check("'Show' reveals the password inside the closed shadow root only",
    m15c && m15c.text.includes(gen.a) && !(await P(`document.documentElement.outerHTML.includes(${JSON.stringify(gen.a)})`)));
  const doneBtn = m15c.items.find((i) => i.label === "Done");
  await mouseClick(doneBtn.x, doneBtn.y);
  await sleep(250);
  check("'Done' closes the menu", !(await menuInfo()));
  // A few more generations: all valid and distinct.
  const many = new Set([gen.a]);
  for (let k = 0; k < 4; k++) {
    gi = await iconFor("u-pass");
    await mouseClick(gi.x, gi.y);
    const mm = await waitFor(menuInfo, 1500);
    await mouseClick(mm.items[0].x, mm.items[0].y);
    await sleep(250);
    const v = await P(`document.getElementById("u-pass").value`);
    if (v.length === 20 && !LOOKALIKE.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9]/.test(v)) many.add(v);
    await key("Escape", "Escape", 27);
  }
  check("repeated generations are all valid and distinct", many.size === 5, String(many.size));
  const last = await P(`document.getElementById("u-pass").value`);
  await typeInto("u-email", "gen@example.com");
  await P(`document.querySelector("#signup button").scrollIntoView({block:"center"})`);
  const sg15 = await P(`(() => { const r = document.querySelector("#signup button").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await mouseClick(sg15.x, sg15.y);
  const p15 = await waitFor(async () => (await pendingEntries())[0], 2000);
  check("on submit the generated password goes through the normal capture (still nothing sent to Notiq)",
    p15 && p15.password === last && p15.username === "gen@example.com" && p15.change === false && (await calls()).length === 0);
  const bar15 = await waitFor(barInfo, 4500);
  check("sign-up offer reads 'Save login to Notiq?'", bar15 && bar15.text.includes("Save login to Notiq?"));

  // 16. Change-password form
  await resetState();
  await load(EXTRA);
  check("extra page: change form (3) + code login (2) icons in the top frame", ((await icons()) || []).length === 5, JSON.stringify(((await icons()) || []).length));
  gi = await iconFor("c-new");
  await mouseClick(gi.x, gi.y);
  const m16 = await waitFor(menuInfo, 1500);
  check("change form menu offers Generate + 'Fill saved login'", m16 && m16.items.map((i) => i.label).join("|") === "Generate strong password|Fill saved login", JSON.stringify(m16 && m16.items));
  await key("Escape", "Escape", 27);
  await typeInto("c-cur", "Old-Pw-1");
  await typeInto("c-new", "New-Pw-22");
  await typeInto("c-new2", "New-Pw-22");
  await P(`document.querySelector("#change button").scrollIntoView({block:"center"})`);
  const cb16 = await P(`(() => { const r = document.querySelector("#change button").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await mouseClick(cb16.x, cb16.y);
  const p16 = await waitFor(async () => (await pendingEntries())[0], 2000);
  check("change-password capture keeps the NEW password and the page's username",
    p16 && p16.password === "New-Pw-22" && p16.username === "zoe@example.com" && p16.change === true, JSON.stringify(p16 && { ...p16, password: p16.password === "New-Pw-22" }));
  const bar16 = await waitFor(barInfo, 4500);
  check("change-password offer reads 'Update password in Notiq?' with an 'Update' button",
    bar16 && bar16.text.includes("Update password in Notiq?") && bar16.buttons.some((b) => b.label === "Update"), JSON.stringify(bar16 && bar16.text));
  const upd = bar16.buttons.find((b) => b.label === "Update");
  await mouseClick(upd.x, upd.y);
  await waitFor(async () => (await calls()).length === 1, 3000);
  const c16 = await calls();
  check("update uses the same native save contract (no extra keys)",
    c16.length === 1 && c16[0].op === "save" && c16[0].password === "New-Pw-22" && tagged(c16[0]) && Object.keys(bare(c16[0])).sort().join() === "host,op,password,title,url,username");

  // 17. Split one-time-code boxes
  await resetState();
  await mockNative({ ...NATIVE, fill: { ...NATIVE.fill, code: "482916" } });
  await load(EXTRA);
  gi = await iconFor("m-pass");
  await mouseClick(gi.x, gi.y);
  await waitFor(async () => (await icons()).some((i) => i.cls.includes("done")), 3000);
  const otp = await P(`({ u: document.getElementById("m-user").value, p: document.getElementById("m-pass").value,
    code: [1,2,3,4,5,6].map((k) => document.getElementById("o" + k).value).join(""), active: document.activeElement.id, inputs: window.__otpInputs })`);
  check("split OTP boxes filled digit by digit, last box focused, input events fired",
    otp.u === "alice@example.com" && otp.p === "Notiq-Filled-1!" && otp.code === "482916" && otp.active === "o6" && otp.inputs >= 6, JSON.stringify({ ...otp, p: "<redacted>" }));
  await mockNative(NATIVE);

  // 18. Iframes: same-site allowed, cross-site ignored
  await resetState();
  await load(EXTRA);
  const frames = await waitFor(async () => { const f = await P("window.__frames"); return f && f.localhost && f["127.0.0.1"] && f; }, 5000);
  check("same-site iframe gets the Notiq overlay", frames && frames.localhost.divs === 1, JSON.stringify(frames));
  check("cross-site iframe is ignored entirely (no overlay)", frames && frames["127.0.0.1"].divs === 0, JSON.stringify(frames));
  const fsh = await inFrameShadow("f-same", `function () { return [...this.querySelectorAll(".nq-icon")].map((b) => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }); }`);
  check("iframe overlay is a closed shadow root too", fsh && fsh.mode === "closed" && fsh.value.length === 2, JSON.stringify(fsh));
  await P(`document.getElementById("f-same").scrollIntoView({block:"center"})`);
  await sleep(300);
  const fr = await P(`(() => { const f = document.getElementById("f-same"); const r = f.getBoundingClientRect(); const pr = f.contentDocument.getElementById("fr-pass").getBoundingClientRect();
    const c = document.getElementById("f-cross").getBoundingClientRect(); return { x: r.x, y: r.y, pw: { right: pr.right, cy: pr.y + pr.height / 2 }, cx: c.x, cy: c.y }; })()`);
  const fIcons = (await inFrameShadow("f-same", `function () { return [...this.querySelectorAll(".nq-icon")].map((b) => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }); }`)).value;
  const fpw = fIcons.find((i) => Math.abs(i.y - fr.pw.cy) < 3);
  await resetCalls();
  await mouseClick(fr.x + fpw.x, fr.y + fpw.y);
  await waitFor(async () => (await P(`document.getElementById("f-same").contentDocument.getElementById("fr-pass").value`)) !== "", 3000);
  const c18 = await calls();
  const fv = await P(`(() => { const d = document.getElementById("f-same").contentDocument; return { u: d.getElementById("fr-user").value, p: d.getElementById("fr-pass").value }; })()`);
  check("same-site iframe fill: one request for the TOP host, credentials land in the frame",
    c18.length === 1 && c18[0].op === "fill" && c18[0].host === "localhost" && fv.u === "alice@example.com" && fv.p === "Notiq-Filled-1!", JSON.stringify({ c18, u: fv.u }));
  await resetCalls();
  // Where the icon would be in the cross-site frame (same layout as the same-site one).
  await mouseClick(fr.cx + fpw.x, fr.cy + fpw.y);
  await sleep(1200);
  check("clicking in the cross-site iframe sends nothing", (await calls()).length === 0);
  // Capture from the same-site frame -> offer in the top frame, saved for the top host.
  await resetState();
  await load(EXTRA);
  await waitFor(async () => { const f = await P("window.__frames"); return f && f.localhost && f.localhost.divs === 1; }, 4000);
  await P(`(() => { document.getElementById("change").hidden = true; document.getElementById("mfa").hidden = true; document.getElementById("f-same").scrollIntoView({block:"center"}); return true; })()`);
  await sleep(300);
  const fpos = await P(`(() => { const f = document.getElementById("f-same"); const r = f.getBoundingClientRect(); const d = f.contentDocument;
    const at = (id) => { const e = d.getElementById(id).getBoundingClientRect(); return { x: r.x + e.x + 20, y: r.y + e.y + e.height / 2 }; }; return { u: at("fr-user"), p: at("fr-pass") }; })()`);
  await mouseClick(fpos.u.x, fpos.u.y);
  await cdp("Input.insertText", { text: "iris@example.com" }, page);
  await mouseClick(fpos.p.x, fpos.p.y);
  await cdp("Input.insertText", { text: "Frame-Pw-10" }, page);
  await pressEnter();
  const p18 = await waitFor(async () => (await pendingEntries())[0], 2500);
  check("same-site iframe capture is stored for the top page (host + url)",
    p18 && p18.host === "localhost" && p18.url === EXTRA && p18.username === "iris@example.com" && p18.password === "Frame-Pw-10", JSON.stringify(p18 && { ...p18, password: "<redacted>" }));
  const bar18 = await waitFor(barInfo, 5000);
  check("top frame shows the save offer for an iframe login", bar18 && bar18.text.includes("Save login to Notiq?") && bar18.text.includes("iris@example.com"), JSON.stringify(bar18 && bar18.text));

  // 19. Account chooser from the in-page icon
  const CHOICES = [
    { account: "acc-work", title: "Work", username: "alice@work.com" },
    { account: "acc-home", title: "<img src=x onerror=alert(1)>Home", username: "alice@home.com" },
  ];
  await resetState();
  await mockNative({ ...NATIVE, fill: { choose: CHOICES, withAccount: { ok: true, username: "alice@home.com", password: "Home-Pw-9", title: "Home" } } });
  await load();
  gi = await iconFor("s-pass");
  await mouseClick(gi.x, gi.y);
  const m19 = await waitFor(menuInfo, 2500);
  check("several matches -> chooser menu with title + username only",
    m19 && m19.label === "Choose a login" && m19.items.length === 2 && m19.text.includes("alice@work.com") && m19.text.includes("alice@home.com"), JSON.stringify(m19));
  check("chooser renders text only (no HTML injection)", m19 && m19.imgs === 0 && m19.text.includes("<img src=x"));
  const c19a = await calls();
  check("first request has no account", c19a.length === 1 && c19a[0].op === "fill" && !("account" in c19a[0]));
  await key("ArrowDown", "ArrowDown", 40);
  const act = (await menuInfo()).active;
  check("arrow keys move through the chooser", act && act.includes("alice@home.com"), JSON.stringify(act));
  await key("Enter", "Enter", 13);
  await waitFor(async () => (await P(`document.getElementById("s-pass").value`)) === "Home-Pw-9", 3000);
  const c19 = await calls();
  const v19 = await P(`({ u: document.getElementById("s-user").value, p: document.getElementById("s-pass").value })`);
  check("chooser round trip: re-sent with the chosen account and filled",
    c19.length === 2 && c19[1].op === "fill" && c19[1].host === "localhost" && c19[1].account === "acc-home" && v19.u === "alice@home.com" && v19.p === "Home-Pw-9",
    JSON.stringify(c19));
  await resetCalls();
  gi = await iconFor("s-pass");
  await mouseClick(gi.x, gi.y);
  await waitFor(menuInfo, 2500);
  await key("Escape", "Escape", 27);
  await sleep(500);
  check("Esc cancels the chooser without another request", !(await menuInfo()) && (await calls()).length === 1);
  // Bad reply: too many entries -> no chooser
  await mockNative({ ...NATIVE, fill: { choose: Array.from({ length: 21 }, (_, k) => ({ account: `a${k}`, title: `T${k}`, username: `u${k}` })) } });
  await load();
  gi = await iconFor("s-pass");
  await mouseClick(gi.x, gi.y);
  await waitFor(async () => (await icons()).some((i) => i.cls.includes("error")), 3000);
  check("oversized choose reply is rejected (no chooser)", !(await menuInfo()) && (await icons()).some((i) => i.cls.includes("error")));
  // A forged account (never offered for this tab) is refused before reaching the app.
  await resetCalls();
  const forged = await SW(`fillForSender({ url: ${JSON.stringify(PAGE)}, frameId: 0, tab: { id: 987654, active: true, url: ${JSON.stringify(PAGE)} } }, { account: "acc-forged" })`);
  check("fill naming an account that was not offered is refused", forged && forged.error === "stale" && (await calls()).length === 0, JSON.stringify(forged));

  // 20. Toolbar / Alt+Shift+L path: background returns the chooser, popup re-sends with account
  await resetState();
  await mockNative({ ...NATIVE, fill: { choose: CHOICES, withAccount: { ok: true, username: "alice@work.com", password: "Work-Pw-8", title: "Work" } } });
  await load();
  // A real toolbar click / Alt+Shift+L grants activeTab, which exposes the tab URL; CDP
  // can't press the toolbar, so the test supplies the URL the grant would expose.
  await SW(`(() => {
    const real = globalThis.__realQuery || chrome.tabs.query.bind(chrome.tabs);
    globalThis.__realQuery = real;
    chrome.tabs.query = async (q) => (await real(q)).map((t) => ({ ...t, url: t.url || ${JSON.stringify(PAGE)} }));
    // Injection itself also needs that grant: record what would be injected instead.
    globalThis.__realExec = globalThis.__realExec || chrome.scripting.executeScript.bind(chrome.scripting);
    globalThis.__injected = [];
    // The secret-free frame probe (phase 1) gets what this page has: the top frame, with a visible password field.
    chrome.scripting.executeScript = async (o) => {
      if (o.func.name === "probeFrame") {
        globalThis.__probes = (globalThis.__probes || 0) + 1;
        return [{ frameId: 0, result: { origin: new URL(${JSON.stringify(PAGE)}).origin, top: true, ancestors: [], fields: true, password: true } }];
      }
      globalThis.__injected.push({ allFrames: o.target.allFrames, frameIds: o.target.frameIds, documentIds: o.target.documentIds, func: o.func.name, args: o.args });
      return [{ frameId: 0, result: 1 }];
    };
    return true;
  })()`);
  const t20 = await SW("fillActiveTab()");
  check("toolbar fill returns the chooser list (no secrets)", t20 && Array.isArray(t20.choose) && t20.choose.length === 2 && !JSON.stringify(t20).includes("Pw"), JSON.stringify(t20));
  const t20b = await SW(`fillActiveTab("acc-work")`);
  const inj = await SW("globalThis.__injected");
  const c20 = await calls();
  check("toolbar re-send with account injects fillPage with that login for the tab host",
    t20b && t20b.ok && c20.length === 2 && c20[1].account === "acc-work" && inj.length === 1 && inj[0].func === "fillPage" && inj[0].allFrames === undefined && JSON.stringify(inj[0].frameIds) === "[0]" &&
    inj[0].args[0] === "localhost" && inj[0].args[1].password === "Work-Pw-8", JSON.stringify({ t20b, n: c20.length }));
  const t20c = await SW(`fillActiveTab("acc-work")`);
  check("an account can be used once per offer (replay refused)", t20c && t20c.error === "stale", JSON.stringify(t20c));
  // fillPage's own logic (what the injection runs), executed in the page.
  const FILLPAGE = await SW("fillPage.toString()");
  await load(EXTRA);
  await P(`document.getElementById("change").hidden = true`);
  const fp = await P(`(${FILLPAGE})("localhost", { username: "u@example.com", password: "Tool-Pw-1", code: "135790" }, { top: location.origin, allowed: [location.origin] })`);
  const fpv = await P(`({ u: document.getElementById("m-user").value, p: document.getElementById("m-pass").value,
    code: [1,2,3,4,5,6].map((k) => document.getElementById("o" + k).value).join(""), active: document.activeElement.id })`);
  check("toolbar fillPage fills login + split OTP boxes", fp === 3 && fpv.u === "u@example.com" && fpv.p === "Tool-Pw-1" && fpv.code === "135790" && fpv.active === "o6", JSON.stringify({ fp, ...fpv, p: "<redacted>" }));
  const fpOther = await P(`(${FILLPAGE})("example.com", { username: "x", password: "y" }, { top: location.origin, allowed: [location.origin] })`);
  check("toolbar fillPage refuses a top page whose host differs", fpOther === 0);
  await SW(`(chrome.tabs.query = globalThis.__realQuery, chrome.scripting.executeScript = globalThis.__realExec, true)`);
  // Popup UI (sendMessage stubbed in the popup page)
  await evalIn(pop, `(() => {
    window.__sent = [];
    const fake = (m, cb) => { window.__sent.push(m); setTimeout(() => cb(m.account ? { ok: true } : { choose: ${JSON.stringify(CHOICES)} }), 50); };
    try { chrome.runtime.sendMessage = fake; } catch {}
    if (chrome.runtime.sendMessage !== fake) Object.defineProperty(chrome.runtime, "sendMessage", { value: fake, configurable: true, writable: true });
    window.close = () => { window.__closed = true; };
    document.getElementById("fill").click();
    return true;
  })()`);
  await cdp("Target.activateTarget", { targetId: popTarget });
  const popState = () => evalIn(pop, `({ hidden: document.getElementById("choose").hidden, items: [...document.querySelectorAll("#choose button")].map((b) => b.textContent),
    imgs: document.querySelectorAll("#choose img").length, msg: document.getElementById("msg").textContent, focus: document.activeElement && document.activeElement.className })`);
  const pop20 = await waitFor(async () => { const s = await popState(); return !s.hidden && s; }, 3000) || await popState();
  check("popup shows the chooser (title + username, text only, first item focused)",
    !pop20.hidden && pop20.items.length === 2 && pop20.items[0] === "Workalice@work.com" && pop20.imgs === 0 && pop20.focus === "choice", JSON.stringify(pop20));
  await evalIn(pop, `document.querySelectorAll("#choose button")[1].click(), true`);
  const sent20 = await waitFor(async () => { const s = await evalIn(pop, "window.__sent"); return s.length === 2 && s; }, 3000) || await evalIn(pop, "window.__sent");
  check("popup re-sends the fill with the chosen account", sent20.length === 2 && sent20[1].type === "fill" && sent20[1].account === "acc-home", JSON.stringify(sent20));

  // 21. Same-site rule (background helper)
  const ss = await SW(`[
    sameSite("login.example.com", "www.example.com"), sameSite("example.com", "example.com"), sameSite("a.b.example.co.uk", "www.example.co.uk"),
    sameSite("evil.com", "example.com"), sameSite("example.com.evil.com", "example.com"), sameSite("evil.co.uk", "example.co.uk"),
    sameSite("other.co.uk", "co.uk"), sameSite("127.0.0.1", "localhost"), sameSite("10.0.0.2", "10.0.0.1"), sameSite("notexample.com", "example.com")
  ]`);
  check("same-site test: subdomains allowed, other sites / public suffixes / IPs refused",
    JSON.stringify(ss) === JSON.stringify([true, true, true, false, false, false, false, false, false, false]), JSON.stringify(ss));
  await mockNative(NATIVE);


  // ===================== 0.4.0 =====================
  // 22. "Fill with Notiq" suggestion on field focus
  const suggestInfo = () => inShadow(`function () {
    const s = this.querySelector(".nq-suggest");
    if (!s || s.style.display === "none") return null;
    const b = s.querySelector(".nq-sbtn");
    const r = b.getBoundingClientRect(), n = s.getBoundingClientRect();
    // top/left from the style (the entry animation shifts the box for a moment)
    return { text: s.textContent, role: s.getAttribute("role"), itemRole: b.getAttribute("role"), x: r.x + r.width / 2, y: parseFloat(s.style.top) + (r.bottom - n.top) - r.height / 2,
      top: parseFloat(s.style.top), left: parseFloat(s.style.left), width: n.width, active: this.activeElement === b, count: this.querySelectorAll(".nq-suggest").length };
  }`);
  const activeId = () => P("document.activeElement && document.activeElement.id");
  await cdp("Target.activateTarget", { targetId }); // the page tab must be the active one (fills from background tabs are refused)
  const fieldBox = (id) => P(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { left: r.left, bottom: r.bottom, width: r.width }; })()`);
  await mockNative(NATIVE);
  await resetState();
  await load();
  check("no suggestion before a field is focused", !(await suggestInfo()));
  await clickId("s-user");
  const sg1 = await waitFor(suggestInfo, 1500);
  const fb1 = await fieldBox("s-user");
  check("focusing a login field shows 'Fill with Notiq' + shortcut hint right under it",
    sg1 && sg1.text === "Fill with NotiqAlt+Shift+L" && Math.abs(sg1.top - (fb1.bottom + 4)) <= 1 && Math.abs(sg1.left - fb1.left) <= 1 && sg1.count === 1,
    JSON.stringify({ sg1, fb1 }));
  check("suggestion uses menu/menuitem roles and shows no vault data", sg1 && sg1.role === "menu" && sg1.itemRole === "menuitem" && !/alice|@/.test(sg1.text));
  check("focus stays in the field while the suggestion shows", (await activeId()) === "s-user");
  check("showing the suggestion asks Notiq for nothing", (await calls()).length === 0);
  await inShadow(`function () { const b = this.querySelector(".nq-sbtn"); b.click(); b.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })); }`);
  await sleep(600);
  check("synthetic click on the suggestion is ignored", (await calls()).length === 0 && !!(await suggestInfo()));
  const sg1b = await suggestInfo();
  await mouseClick(sg1b.x, sg1b.y);
  check("a real click keeps focus in the field (no focus steal)", ["s-user", "s-pass"].includes(await activeId()));
  await waitFor(async () => (await calls()).length === 1, 3000);
  const c22 = await calls();
  check("clicking the suggestion runs the same fill as the key icon", c22.length === 1 && c22[0].op === "fill" && c22[0].host === "localhost", JSON.stringify(c22));
  const v22 = await waitFor(async () => { const v = await P(`document.getElementById("s-pass").value`); return v === "Notiq-Filled-1!" && v; }, 3000);
  check("…and the form is filled after approval", !!v22);
  await sleep(300);
  check("suggestion is gone after the click and not re-opened by the fill's own focus", !(await suggestInfo()));

  // keyboard
  await resetState();
  await load();
  await clickId("s-user");
  await waitFor(suggestInfo, 1500);
  await key("ArrowDown", "ArrowDown", 40);
  await sleep(150);
  check("ArrowDown from the field moves focus into the suggestion", !!(await suggestInfo())?.active);
  await key("ArrowUp", "ArrowUp", 38);
  await sleep(150);
  check("ArrowUp returns focus to the field", (await activeId()) === "s-user" && !!(await suggestInfo()));
  await key("ArrowDown", "ArrowDown", 40);
  await key("Enter", "Enter", 13);
  await waitFor(async () => (await calls()).length === 1, 3000);
  check("Enter on the focused suggestion fills (one request)", (await calls()).length === 1 && (await calls())[0].op === "fill");
  await waitFor(async () => (await P(`document.getElementById("s-pass").value`)) === "Notiq-Filled-1!", 3000);

  // Esc dismisses per field; typing and clicking outside hide it
  await resetState();
  await load();
  await clickId("s-user");
  await waitFor(suggestInfo, 1500);
  await key("Escape", "Escape", 27);
  await sleep(200);
  check("Esc hides the suggestion and keeps focus in the field", !(await suggestInfo()) && (await activeId()) === "s-user");
  await clickId("s-pass");
  const sgPw = await waitFor(suggestInfo, 1500);
  check("another login field still gets its suggestion", !!sgPw);
  await cdp("Input.insertText", { text: "x" }, page);
  await sleep(200);
  check("typing into the field hides the suggestion", !(await suggestInfo()));
  await clickId("s-user");
  await sleep(500);
  check("a field dismissed with Esc gets no suggestion again on this page", !(await suggestInfo()));
  await clickId("t-user");
  await waitFor(suggestInfo, 1500);
  const h1 = await P(`(() => { const r = document.querySelector("h1").getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; })()`);
  await mouseClick(h1.x, h1.y);
  await sleep(200);
  check("clicking outside hides the suggestion", !(await suggestInfo()));
  await clickId("u-name");
  await sleep(500);
  check("non-login fields (full name) get no suggestion", !(await suggestInfo()));
  await P(`document.body.style.minHeight = "3000px"`);
  await P(`document.getElementById("t-user").focus()`);
  await sleep(300);
  const sgScroll = await suggestInfo();
  await P(`window.scrollBy(0, 40)`);
  await sleep(250);
  const sgScroll2 = await suggestInfo();
  const fbT = await fieldBox("t-user");
  check("suggestion follows the field on scroll", sgScroll && sgScroll2 && sgScroll2.top !== sgScroll.top && Math.abs(sgScroll2.top - (fbT.bottom + 4)) <= 1, JSON.stringify({ sgScroll, sgScroll2, fbT }));
  await SW(`chrome.storage.local.set({ suggestOnFocus: false }).then(() => true)`);
  check("turning 'Suggest on field focus' off hides it live", await waitFor(async () => !(await suggestInfo()), 1500));
  await clickId("s-pass");
  await sleep(500);
  check("suggestOnFocus=false: no suggestion (icons still shown)", !(await suggestInfo()) && ((await icons()) || []).length > 0);
  await resetState({ showIcon: false });
  await load();
  await clickId("s-user");
  await sleep(600);
  check("showIcon=false: no suggestion either", !(await suggestInfo()) && ((await icons()) || []).length === 0);
  // OTP field on the extra page gets no suggestion
  await resetState();
  await load(EXTRA);
  const otpIds = await P(`[...document.querySelectorAll("input")].filter((i) => /otp|code/i.test(i.id + i.name + i.autocomplete) && i.maxLength !== 1 && i.offsetWidth > 0).map((i) => i.id).filter(Boolean)`);
  if (otpIds.length) {
    await clickId(otpIds[0]);
    await sleep(500);
    check("one-time-code fields get no suggestion", !(await suggestInfo()), otpIds[0]);
  }

  // 23. Theme from the Notiq app
  const THEME = { id: "nord", mode: "dark", bg: "#2e3440", bgSecondary: "#3b4252", bgTertiary: "#434c5e", text: "#eceff4",
    textMuted: "#8892a4", border: "#4c566a", primary: "#88c0d0", primaryText: "#1d232d", danger: "#bf616a", success: "#a3be8c" };
  const LIGHT = { id: "light", mode: "light", bg: "#f8fafc", bgSecondary: "#f1f5f9", bgTertiary: "#e2e8f0", text: "#1e293b",
    textMuted: "#64748b", border: "#cbd5e1", primary: "#b45309", primaryText: "#ffffff", danger: "#dc2626", success: "#16a34a" };
  const themeCalls = async () => (await allCalls()).filter((c) => c.op === "theme");
  await resetState();
  await mockNative({ ...NATIVE, theme: { ok: true, theme: THEME } });
  await resetCalls();
  const { targetId: pop2Target } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId: pop2 } = await cdp("Target.attachToTarget", { targetId: pop2Target, flatten: true });
  await cdp("Runtime.enable", {}, pop2);
  const stored = await waitFor(async () => (await local()).theme, 3000);
  const tc = await themeCalls();
  check("opening the popup refreshes the theme ({op:'theme'} only, no host)", tc.length === 1 && JSON.stringify(bare(tc[0])) === '{"op":"theme"}' && tagged(tc[0]), JSON.stringify(tc));
  check("validated theme cached in storage.local", stored && stored.id === "nord" && stored.bg === "#2e3440", JSON.stringify(stored));
  const popVars = await waitFor(async () => { const v = await evalIn(pop2, `getComputedStyle(document.documentElement).getPropertyValue("--nq-bg").trim()`); return v === "#2e3440" && v; }, 2000);
  check("popup styles itself from the theme", popVars === "#2e3440");
  await SW(`chrome.storage.local.remove("suggestOnFocus").then(() => true)`); // real default: off
  await sleep(300);
  const popInfo = await evalIn(pop2, `({ ver: document.getElementById("version").textContent, sw: [...document.querySelectorAll('input[type=checkbox]')].map((i) => i.getAttribute("role") + ":" + i.id + ":" + i.checked),
    status: document.getElementById("status").dataset.state, bg: getComputedStyle(document.body).backgroundColor })`);
  check("popup: version footer, role=switch toggles incl. 'Suggest on field focus', 'Hide Notiq on this site' and the experimental passkeys (off), status dot",
    popInfo.ver === "Notiq Autofill v0.7.0" && popInfo.sw.join() === "switch:siteHide:false,switch:showIcon:true,switch:suggestOnFocus:false,switch:offerSave:true,switch:passkeys:false" &&
    ["on", "off"].includes(popInfo.status) && popInfo.bg === "rgb(46, 52, 64)", JSON.stringify(popInfo));
  await evalIn(pop2, `document.getElementById("suggestOnFocus").click(), true`);
  check("popup toggle writes suggestOnFocus", await waitFor(async () => (await local()).suggestOnFocus === true, 1500));
  await evalIn(pop2, `document.getElementById("showIcon").click(), true`);
  await sleep(300);
  check("suggest toggle is disabled while the icon is off", await evalIn(pop2, `document.getElementById("suggestOnFocus").disabled`));
  await SW(`chrome.storage.local.set({ showIcon: true, suggestOnFocus: true }).then(() => true)`);
  await cdp("Target.activateTarget", { targetId });

  await load();
  await clickId("s-user");
  await waitFor(suggestInfo, 1500);
  const pageVars = () => inShadow(`function () { const r = this.querySelector(".nq-root"); const s = this.querySelector(".nq-suggest");
    return { bg: r.style.getPropertyValue("--nq-bg"), mode: r.getAttribute("data-nq-mode"), suggestBg: s ? getComputedStyle(s).backgroundColor : null,
      iconColor: getComputedStyle(this.querySelector(".nq-icon")).color }; }`);
  const pv = await pageVars();
  check("in-page UI (suggestion, icon) uses the app's theme", pv.bg === "#2e3440" && pv.mode === "dark" && pv.suggestBg === "rgb(46, 52, 64)" && pv.iconColor === "rgb(136, 192, 208)", JSON.stringify(pv));
  await SW(`chrome.storage.local.set({ theme: ${JSON.stringify(LIGHT)} }).then(() => true)`);
  const pvLive = await waitFor(async () => { const v = await pageVars(); return v.bg === "#f8fafc" && v; }, 1500);
  check("theme change applies live in the page", pvLive && pvLive.mode === "light" && pvLive.suggestBg === "rgb(248, 250, 252)", JSON.stringify(pvLive));
  await SW(`chrome.storage.local.set({ theme: { ...${JSON.stringify(LIGHT)}, bg: "#fff;background:red" } }).then(() => true)`);
  const pvBad = await waitFor(async () => { const v = await pageVars(); return v.bg !== "#f8fafc" && v; }, 1500);
  check("a malformed cached theme is re-validated in the page (falls back to a default)", pvBad && ["#0f172a", "#ffffff"].includes(pvBad.bg), JSON.stringify(pvBad));

  const refresh = () => SW(`chrome.storage.session.remove("themeAt").then(() => refreshTheme(60000)).then((t) => t)`);
  await SW(`chrome.storage.local.set({ theme: ${JSON.stringify(THEME)} }).then(() => true)`);
  await mockNative({ ...NATIVE, theme: { ok: true, theme: { ...LIGHT, primary: "#b4530" } } });
  await refresh();
  check("invalid theme reply is rejected (cache kept)", (await local()).theme?.id === "nord");
  await mockNative({ ...NATIVE, theme: { error: "app_not_running" } });
  await refresh();
  check("app not running: cached theme kept", (await local()).theme?.id === "nord");
  await mockNative({ ...NATIVE, theme: { error: "unknown_op" } });
  await refresh();
  check("older app (unknown_op): treated as no theme", (await local()).theme === undefined);
  await SW(`chrome.storage.local.set({ theme: ${JSON.stringify(THEME)} }).then(() => true)`);
  await mockNative({ ...NATIVE, theme: { ok: true, theme: null } });
  await refresh();
  check("theme:null clears the cached theme", (await local()).theme === undefined);

  // content-script nudge: at most one host round trip a minute, and never on page load
  await mockNative({ ...NATIVE, theme: { ok: true, theme: THEME } });
  await SW(`chrome.storage.session.set({ themeAt: Date.now() }).then(() => true)`);
  await resetCalls();
  await load();
  check("page load asks Notiq nothing, not even the theme", (await allCalls()).length === 0);
  await clickId("s-user");
  await waitFor(suggestInfo, 1500);
  await sleep(600);
  check("nudge within a minute of the last refresh does not reach the host", (await themeCalls()).length === 0);
  await SW(`chrome.storage.session.set({ themeAt: Date.now() - 120000 }).then(() => true)`);
  await load();
  await clickId("s-user");
  await waitFor(async () => (await themeCalls()).length === 1, 2000);
  await load();
  await clickId("s-user");
  await sleep(800);
  const tc2 = await themeCalls();
  check("stale theme: first nudge refreshes once, the next page does not", tc2.length === 1 && JSON.stringify(bare(tc2[0])) === '{"op":"theme"}' && tagged(tc2[0]), JSON.stringify(tc2));
  check("theme arrived through the nudge", (await local()).theme?.id === "nord");

  // ===================== multi-step sign-in =====================
  // 24. Username page, then password page: one approval fills both, nothing is submitted
  const STEPS = `http://localhost:${PORT}/test-pages/signin-steps.html`;
  const stepEntries = async () => Object.entries(await session()).filter(([k]) => k.startsWith("step:")).map(([, v]) => v);
  const stepVals = () => P(`({ u: document.getElementById("m-user").value, p: document.getElementById("m-pass").value,
    done: document.getElementById("m-done").classList.contains("show") })`).catch(() => null);
  const fillStep1 = async () => {
    const ui = await iconFor("m-user");
    if (!ui) return false;
    await mouseClick(ui.x, ui.y);
    return !!(await waitFor(async () => (await icons()).some((i) => i.cls.includes("done")), 3000));
  };
  await mockNative(NATIVE);
  await resetState({ suggestOnFocus: false });
  await load(STEPS);
  check("username-only page: icon on the username field only", (await icons()).length === 1);
  check("username-only page: the fill completes", await fillStep1());
  const v24 = await stepVals();
  const c24 = await calls();
  check("username-only page: one fill request, only the username goes in", c24.length === 1 && c24[0].op === "fill" && v24.u === "alice@example.com" && v24.p === "",
    JSON.stringify({ n: c24.length, u: v24.u, pLen: v24.p.length }));
  const held = await stepEntries();
  check("password held in storage.session for this tab and host only",
    held.length === 1 && held[0].host === "localhost" && held[0].password === "Notiq-Filled-1!" && !JSON.stringify(await local()).includes("Notiq-Filled-1!"));
  check("page DOM never sees the held password", !(await P(`document.documentElement.outerHTML.includes("Notiq-Filled-1!")`)));
  await clickId("m-next");
  const spa = await waitFor(async () => { const v = await stepVals(); return v && v.p === "Notiq-Filled-1!" && v; }, 3000);
  check("SPA step: password filled without asking Notiq again", spa && (await calls()).length === 1, JSON.stringify(spa && { ...spa, p: "<redacted>" }));
  check("SPA step: the lock state was checked (ping) before the hand-out", (await pings()).length >= 1);
  check("SPA step: held password gone after use, form not submitted", (await stepEntries()).length === 0 && spa && !spa.done);
  check("SPA step: the icon shows 'Filled'", !!(await waitFor(async () => (await icons()).some((i) => i.cls.includes("done") && i.tip === "Filled"), 1500)));

  // Next step is a new page on the same site
  await resetState({ suggestOnFocus: false });
  await load(STEPS);
  await fillStep1();
  await clickId("m-next-nav");
  await sleep(300);
  for (let i = 0; i < 30; i++) { await sleep(100); if ((await P("document.readyState").catch(() => "")) === "complete") break; }
  const nav = await waitFor(async () => { const v = await stepVals(); return v && v.p === "Notiq-Filled-1!" && v; }, 4000);
  check("new-page step: password filled on the next page, once, without a second request",
    nav && (await calls()).length === 1 && (await stepEntries()).length === 0 && !nav.done);

  // Expired: nothing is filled and the entry is dropped
  await resetState({ suggestOnFocus: false });
  await load(STEPS);
  await fillStep1();
  await SW(`chrome.storage.session.get(null).then(async (all) => { for (const k of Object.keys(all)) if (k.startsWith("step:")) await chrome.storage.session.set({ [k]: { ...all[k], at: Date.now() - 121000 } }); return true; })`);
  await clickId("m-next");
  await sleep(1200);
  const exp = await stepVals();
  check("expired hand-off: password not filled, entry dropped", exp && exp.p === "" && (await stepEntries()).length === 0);

  // Another site (127.0.0.1 is not localhost's site) gets nothing
  await resetState({ suggestOnFocus: false });
  await load(STEPS);
  await fillStep1();
  await load(`http://127.0.0.1:${PORT}/test-pages/signin-steps.html?step=2`);
  await sleep(800);
  const other = await stepVals();
  check("another site's password page gets nothing and the held password is dropped", other && other.p === "" && (await stepEntries()).length === 0,
    JSON.stringify(other && { p: other.p.length }));

  // Closing the tab clears it
  await resetState({ suggestOnFocus: false });
  const mainPage = page;
  const { targetId: t24 } = await cdp("Target.createTarget", { url: "about:blank" });
  ({ sessionId: page } = await cdp("Target.attachToTarget", { targetId: t24, flatten: true }));
  for (const d of ["Page.enable", "DOM.enable", "Runtime.enable"]) await cdp(d, {}, page);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }, page);
  await load(STEPS);
  await fillStep1();
  const before24 = (await stepEntries()).length;
  await cdp("Target.closeTarget", { targetId: t24 });
  page = mainPage;
  await waitFor(async () => (await stepEntries()).length === 0, 2000);
  check("closing the tab drops the held password", before24 === 1 && (await stepEntries()).length === 0, JSON.stringify({ before24 }));
  await cdp("Target.activateTarget", { targetId });

  // Screenshots for visual review (NOTIQ_SHOTS=<dir>).
  if (process.env.NOTIQ_SHOTS) {
    const dir = resolve(process.env.NOTIQ_SHOTS);
    mkdirSync(dir, { recursive: true });
    const shoot = async (session, file, clip) => {
      const { data } = await cdp("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, session);
      writeFileSync(join(dir, file), Buffer.from(data, "base64"));
    };
    await cdp("Page.enable", {}, pop2);
    await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 2, mobile: false }, pop2);
    const DEFAULT_DARK = { id: "notiq-dark", mode: "dark", bg: "#0f172a", bgSecondary: "#1e293b", bgTertiary: "#334155", text: "#e2e8f0",
      textMuted: "#94a3b8", border: "#334155", primary: "#c9a84c", primaryText: "#0f172a", danger: "#f87171", success: "#4ade80" };
    for (const [name, theme] of [["dark", DEFAULT_DARK], ["light", LIGHT], ["nord", THEME]]) {
      await cdp("Target.activateTarget", { targetId: pop2Target });
      await SW(`chrome.storage.local.set({ theme: ${JSON.stringify(theme)}, neverSave: ["accounts.example.com", "old-bank.example"] }).then(() => true)`);
      await evalIn(pop2, `(() => { showView("never"); return true; })()`);
      await sleep(300);
      const h = await evalIn(pop2, `Math.ceil(document.documentElement.getBoundingClientRect().height)`);
      await shoot(pop2, `popup-${name}.png`, { x: 0, y: 0, width: 320, height: h });
      await evalIn(pop2, `(() => { showView("settings"); showView("main"); const m = document.getElementById("msg"); m.className = ""; m.textContent = "Several logins match. Pick one:";
        const c = document.getElementById("choose"); c.hidden = false; c.textContent = "";
        for (const [t, u] of [["Work", "alice@work.com"], ["Home", "alice@home.example"]]) { const li = document.createElement("li"); const b = document.createElement("button");
          b.className = "choice"; const a = document.createElement("span"); a.className = "t"; a.textContent = t; const d = document.createElement("span"); d.className = "u"; d.textContent = u;
          b.append(a, d); li.append(b); c.append(li); } return true; })()`);
      await sleep(150);
      const h2 = await evalIn(pop2, `Math.ceil(document.documentElement.getBoundingClientRect().height)`);
      await shoot(pop2, `popup-chooser-${name}.png`, { x: 0, y: 0, width: 320, height: h2 });
      await evalIn(pop2, `(() => { document.getElementById("choose").hidden = true; document.getElementById("msg").textContent = ""; return true; })()`);
      await cdp("Target.activateTarget", { targetId });
      await load();
      await clickId("s-user");
      await waitFor(suggestInfo, 1500);
      await sleep(250);
      const fb = await fieldBox("s-user");
      const r = await P(`(() => { const r = document.getElementById("simple").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      await shoot(page, `suggest-${name}.png`, { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: Math.max(r.height, fb.bottom - r.y + 60) + 16 });
    }
    await SW(`chrome.storage.local.set({ theme: ${JSON.stringify(DEFAULT_DARK)} }).then(() => true)`);
    await cdp("Target.closeTarget", { targetId: pop2Target });
    console.log(`screenshots written to ${dir}`);
  } else {
    await cdp("Target.closeTarget", { targetId: pop2Target });
  }

  // 25. Login forms inside open shadow roots (web components)
  const SHADOW = `http://localhost:${PORT}/test-pages/shadow-login.html`;
  // Centre of a field reached through open roots (window.__field on the test page), and the icon drawn in it.
  const shadowBox = (path) => P(`(() => { const e = window.__field(${JSON.stringify(path)}); e.scrollIntoView({ block: "center" });
    const r = e.getBoundingClientRect(); return { x: r.x + 20, right: r.right, cy: r.y + r.height / 2 }; })()`);
  const shadowIcon = async (path) => {
    const f = await shadowBox(path);
    await sleep(250);
    return ((await icons()) || []).find((i) => Math.abs(i.y - f.cy) < 3 && i.x < f.right && i.x > f.right - 30) || null;
  };
  const shadowVal = (path) => P(`window.__field(${JSON.stringify(path)}).value`);
  await resetState();
  await mockNative(NATIVE);
  await load(SHADOW);
  await sleep(1500); // the late component renders its form after 1.2 s
  const ic25 = (await icons()) || [];
  check("shadow DOM: icons on the open-root forms (2 + nested 2 + late 2), none in the closed root", ic25.length === 6, String(ic25.length));
  const si = await shadowIcon(["#c1", "#c1-pass"]);
  check("shadow DOM: the icon sits at the right inside edge of the shadow field", !!si);
  await mouseClick(si.x, si.y);
  await waitFor(async () => (await shadowVal(["#c1", "#c1-pass"])) !== "", 3000);
  check("shadow DOM: one fill fills username and password inside the open root",
    (await shadowVal(["#c1", "#c1-user"])) === "alice@example.com" && (await shadowVal(["#c1", "#c1-pass"])) === "Notiq-Filled-1!");
  const si2 = await shadowIcon(["#c2", "#c2-pass", "input"]);
  await sleep(2100); // the previous icon's "done" state
  await mouseClick(si2.x, si2.y);
  await waitFor(async () => (await shadowVal(["#c2", "#c2-pass", "input"])) !== "", 3000);
  check("shadow DOM: nested components (email and password each in its own root) are filled together",
    (await shadowVal(["#c2", "#c2-user", "input"])) === "alice@example.com" && (await shadowVal(["#c2", "#c2-pass", "input"])) === "Notiq-Filled-1!");
  check("shadow DOM: the late-rendered form got its icons", !!(await shadowIcon(["#c3", "#c3-pass"])));
  check("shadow DOM: the closed root's fields stay untouched", await P(`document.getElementById("c4").shadowRoot === null`));
  // Capture from a shadow form: typed login, Enter submits the form inside the root.
  await resetState();
  await load(SHADOW);
  for (const [path, text] of [[["#c1", "#c1-user"], "sam@example.com"], [["#c1", "#c1-pass"], "Shadow-Typed-7!"]]) {
    const b = await shadowBox(path);
    await mouseClick(b.x, b.cy);
    await cdp("Input.insertText", { text }, page);
  }
  await pressEnter();
  const p25 = await waitFor(async () => (await pendingEntries())[0], 2500);
  check("shadow DOM: a login submitted inside an open root is offered for saving",
    p25 && p25.username === "sam@example.com" && p25.password === "Shadow-Typed-7!", JSON.stringify(p25 && { ...p25, password: "<redacted>" }));

  // 26. The generator follows the site's maxlength / passwordrules / pattern
  const RULES = `http://localhost:${PORT}/test-pages/signup-rules.html`;
  await resetState();
  await mockNative(NATIVE);
  await load(RULES);
  const generate = async (id) => {
    const gi26 = await iconFor(id);
    if (!gi26) return null;
    await mouseClick(gi26.x, gi26.y);
    const m = await waitFor(menuInfo, 1500);
    if (!m || !m.items.length) return null;
    const sub = m.text;
    await mouseClick(m.items[0].x, m.items[0].y);
    await sleep(400);
    const after = await menuInfo();
    await key("Escape", "Escape", 27);
    await sleep(250);
    return { sub, after: after ? after.text : "" };
  };
  const fieldVals = (ids) => P(`${JSON.stringify(ids)}.map((id) => document.getElementById(id).value)`);
  let g26 = await generate("m-pass");
  let v26 = await fieldVals(["m-pass", "m-pass2"]);
  check("maxlength=16: menu says 16 characters, both fields get the same 16-character password",
    g26 && /16 characters/.test(g26.sub) && v26[0].length === 16 && v26[0] === v26[1] && /[A-Z]/.test(v26[0]) && /[^A-Za-z0-9]/.test(v26[0]),
    JSON.stringify({ sub: g26 && g26.sub, len: v26[0].length }));
  g26 = await generate("r-pass");
  v26 = await fieldVals(["r-pass", "r-pass2"]);
  check("passwordrules: 14 characters, lower+upper+digit, only -_. as symbols, confirm field too",
    v26[0].length === 14 && v26[0] === v26[1] && /^[A-Za-z0-9._-]+$/.test(v26[0]) && /[a-z]/.test(v26[0]) && /[A-Z]/.test(v26[0]) && /\d/.test(v26[0]),
    JSON.stringify({ len: v26[0].length }));
  g26 = await generate("p-pass");
  v26 = await fieldVals(["p-pass"]);
  check("pattern [A-Za-z0-9]{8,12}: 12 letters/digits, valid for the browser",
    /^[A-Za-z0-9]{12}$/.test(v26[0]) && (await P(`document.getElementById("p-pass").checkValidity()`)), JSON.stringify({ len: v26[0].length }));
  g26 = await generate("i-pass");
  v26 = await fieldVals(["i-pass"]);
  check("impossible rules: a warning, and the default password capped at the 10-character maximum",
    g26 && /couldn.t be met/.test(g26.after) && v26[0].length === 10, JSON.stringify({ after: g26 && g26.after, len: v26[0].length }));
  g26 = await generate("j-pass");
  v26 = await fieldVals(["j-pass", "j-pass2"]);
  check("a script that cuts the value: retried at its length, the page keeps exactly what was generated (both fields)",
    v26[0].length === 10 && v26[0] === v26[1] && /[A-Z]/.test(v26[0]), JSON.stringify({ len: v26[0].length, same: v26[0] === v26[1] }));
  check("generating with rules sends nothing to Notiq", (await calls()).length === 0);

  // 27. The 2FA step on its own page: code-only fill (single field and split boxes)
  const OTP = `http://localhost:${PORT}/test-pages/otp.html`;
  // An older app ignores the intent and sends the whole login: the page must still get only the code.
  await resetState();
  await mockNative({ ...NATIVE, fill: { ...NATIVE.fill, code: "482916" } });
  await load(OTP);
  const ic27 = (await icons()) || [];
  check("2FA page: one icon on the code field, one after the split boxes", ic27.length === 2, String(ic27.length));
  let ci = await iconFor("code");
  check("2FA page: the code field's icon sits inside it", !!ci);
  await mouseClick(ci.x, ci.y);
  await waitFor(async () => (await P(`document.getElementById("code").value`)) !== "", 3000);
  const c27 = await calls();
  check("2FA page: one fill request with intent 'code' for the page host",
    c27.length === 1 && c27[0].op === "fill" && c27[0].host === "localhost" && c27[0].intent === "code", JSON.stringify(c27));
  check("2FA page: the code goes into the field", (await P(`document.getElementById("code").value`)) === "482916");
  check("2FA page: the password never reaches the page", !(await P(`document.documentElement.outerHTML.includes("Notiq-Filled-1!")`)));
  const t27 = await waitFor(async () => (await icons()).find((i) => i.tip === "Code filled"), 1500);
  check("2FA page: the icon says 'Code filled'", !!t27);
  // Split boxes: the icon right after the last box fills one digit per box.
  const lastBox = await P(`(() => { const r = document.getElementById("b6").getBoundingClientRect(); return { right: r.right, cy: r.y + r.height / 2 }; })()`);
  await sleep(2000);
  const bi = ((await icons()) || []).find((i) => Math.abs(i.y - lastBox.cy) < 3 && i.x > lastBox.right && i.x < lastBox.right + 30);
  check("2FA page: the split-box icon sits just after the last box", !!bi, JSON.stringify({ lastBox, ic: await icons() }));
  await resetCalls();
  await mouseClick(bi.x, bi.y);
  await waitFor(async () => (await P(`document.getElementById("b6").value`)) !== "", 3000);
  const bx = await P(`({ code: [1,2,3,4,5,6].map((k) => document.getElementById("b" + k).value).join(""), active: document.activeElement.id, inputs: window.__boxInputs })`);
  check("2FA page: split boxes get one digit each, the last box is focused", bx.code === "482916" && bx.active === "b6" && bx.inputs >= 6, JSON.stringify(bx));
  const c27b = await calls();
  check("2FA page: the split boxes asked with intent 'code' too", c27b.length === 1 && c27b[0].intent === "code");
  // No 2FA secret saved: a clear message, nothing filled.
  await resetState();
  await mockNative({ ...NATIVE, fill: { error: "no_code" } });
  await load(OTP);
  ci = await iconFor("code");
  await mouseClick(ci.x, ci.y);
  const e27 = await waitFor(async () => (await icons()).find((i) => i.cls.includes("error")), 3000);
  check("2FA page: no saved code -> 'No 2FA code saved for this site'", e27 && /No 2FA code saved/.test(e27.tip) && (await P(`document.getElementById("code").value`)) === "",
    JSON.stringify(e27));
  // A login page with a code field keeps the old behaviour (no code icon: the normal fill brings the code).
  await resetState();
  await load(EXTRA);
  check("login page with code boxes: still no code-only icon", ((await icons()) || []).length === 5);

  // 28. Custom fields filled by name with the login (test-pages/custom-fields.html)
  const CF = `http://localhost:${PORT}/test-pages/custom-fields.html`;
  const FIELDS = [
    { name: "Customer ID", value: "C-1001", secret: false },
    { name: "Membership No.", value: "M-42", secret: false },
    { name: "PIN", value: "4321", secret: true },
    { name: "Branch", value: "North", secret: false },
    { name: "Account nickname", value: "Daily", secret: false },
  ];
  const cfVals = (ids) => P(`(${JSON.stringify(ids)}).reduce((o, id) => (o[id] = document.getElementById(id).value, o), {})`);
  await resetState();
  await mockNative({ ...NATIVE, fill: { ...NATIVE.fill, fields: FIELDS } });
  await load(CF);
  let cfi = await iconFor("b-pass");
  check("custom fields: the bank form's password field has an icon", !!cfi);
  await mouseClick(cfi.x, cfi.y);
  await waitFor(async () => (await P(`document.getElementById("b-pass").value`)) !== "", 3000);
  const v28 = await cfVals(["b-cust", "b-member", "b-user", "b-pass", "b-pin", "b-pincode", "b-branch", "b-nick", "b-hidden", "b-gone", "p-member", "ph-cust"]);
  check("custom fields: Customer ID, Membership No., PIN and nickname filled by name next to the login",
    v28["b-cust"] === "C-1001" && v28["b-member"] === "M-42" && v28["b-pin"] === "4321" && v28["b-nick"] === "Daily" &&
    v28["b-user"] === "alice@example.com" && v28["b-pass"] === "Notiq-Filled-1!", JSON.stringify({ ...v28, "b-pass": "<redacted>" }));
  check("custom fields: 'PIN code' stays empty, a filled field is kept, hidden fields untouched",
    v28["b-pincode"] === "" && v28["b-branch"] === "Main street" && v28["b-hidden"] === "" && v28["b-gone"] === "", JSON.stringify(v28));
  check("custom fields: other forms on the page are left alone", v28["p-member"] === "" && v28["ph-cust"] === "");
  check("custom fields: focus stays on the login's field", (await P(`document.activeElement && document.activeElement.id`)) === "b-pass");
  // The site calls its password "PIN": the password goes there and the custom PIN never replaces it.
  await resetCalls();
  cfi = await iconFor("p-pass");
  await mouseClick(cfi.x, cfi.y);
  await waitFor(async () => (await P(`document.getElementById("p-pass").value`)) !== "", 3000);
  const v28b = await cfVals(["p-user", "p-pass", "p-member"]);
  check("custom fields: a password field labelled 'PIN' keeps the password; username field keeps the username",
    v28b["p-pass"] === "Notiq-Filled-1!" && v28b["p-user"] === "alice@example.com" && v28b["p-member"] === "M-42", JSON.stringify({ ...v28b, "p-pass": "<redacted>" }));
  // An older app sends no fields: the fill is exactly as before.
  await resetState();
  await mockNative(NATIVE);
  await load(CF);
  cfi = await iconFor("b-pass");
  await mouseClick(cfi.x, cfi.y);
  await waitFor(async () => (await P(`document.getElementById("b-pass").value`)) !== "", 3000);
  const v28c = await cfVals(["b-cust", "b-pin", "b-user"]);
  check("custom fields: none from the app -> only the login is filled", v28c["b-cust"] === "" && v28c["b-pin"] === "" && v28c["b-user"] === "alice@example.com", JSON.stringify(v28c));
  // Toolbar path: fillPage with the matcher loaded (the background injects fillkit.js first).
  await load(CF);
  await P(readFileSync(join(EXT, "fillkit.js"), "utf8"));
  const fp28 = await P(`(${FILLPAGE})("localhost", { username: "u@example.com", password: "Tool-Pw-1", code: "", fields: ${JSON.stringify(FIELDS)} }, { top: location.origin, allowed: [location.origin] })`);
  const v28d = await cfVals(["b-cust", "b-member", "b-pin", "b-pincode", "b-branch", "b-user", "p-member"]);
  check("custom fields: toolbar fill fills them by name too (same rules)",
    fp28 === 6 && v28d["b-cust"] === "C-1001" && v28d["b-member"] === "M-42" && v28d["b-pin"] === "4321" && v28d["b-pincode"] === "" &&
    v28d["b-branch"] === "Main street" && v28d["b-user"] === "u@example.com" && v28d["p-member"] === "", JSON.stringify({ fp28, ...v28d }));

  // 29. Toolbar popup: this site's logins (0.9.0). Background handlers first (the popup opened in a CDP tab
  // counts as a tab sender, so its own messages are stubbed below, as in check 20).
  {
    const ACC = [
      { account: "Logins/Work.nqv", title: "Work", username: "alice@work.com", totp: true },
      { account: "Logins/Home.nqv", title: "<img src=x onerror=alert(1)>Home", username: "alice@home.com", totp: false },
    ];
    await resetState();
    await mockNative({ ...NATIVE, list: { ok: true, accounts: ACC }, copy: { ok: true, copied: "password", clearAfter: 30 }, open: { ok: true } });
    await SW(`(() => {
      const real = globalThis.__realQuery || chrome.tabs.query.bind(chrome.tabs);
      globalThis.__realQuery = real;
      chrome.tabs.query = async (q) => (await real(q)).map((t) => ({ ...t, url: ${JSON.stringify(PAGE)} }));
      return true;
    })()`);
    const l28 = await SW("POPUP_HANDLERS.list()");
    const c28 = await calls();
    check("popup list: the app is asked for the active tab's host only (tagged), names come back",
      l28 && l28.ok && l28.host === "localhost" && l28.accounts.length === 2 && c28.length === 1 && JSON.stringify(bare(c28[0])) === '{"op":"list","host":"localhost"}' && tagged(c28[0]),
      JSON.stringify({ l28, c28 }));
    const cp28 = await SW(`POPUP_HANDLERS.copy({ account: "Logins/Work.nqv", what: "password" })`);
    const c28b = (await calls())[1];
    check("popup copy: forwards {op:'copy', host, account, what}; reply has no value",
      cp28 && cp28.ok && cp28.copied === "password" && cp28.clearAfter === 30 && c28b && c28b.op === "copy" && c28b.host === "localhost" && c28b.account === "Logins/Work.nqv" && c28b.what === "password",
      JSON.stringify({ cp28, c28b }));
    const st28 = await SW(`POPUP_HANDLERS.copy({ account: "Logins/Forged.nqv", what: "password" })`);
    check("popup copy of an account that was not listed is refused before the app", st28 && st28.error === "stale" && (await calls()).length === 2, JSON.stringify(st28));
    const op28 = await SW(`POPUP_HANDLERS.open({ account: "Logins/Home.nqv" })`);
    check("popup open: forwards {op:'open'} for a listed account", op28 && op28.ok && (await calls())[2].op === "open", JSON.stringify(op28));
    await mockNative({ ...NATIVE, list: { error: "unknown_op" } });
    const old28 = await SW("POPUP_HANDLERS.list()");
    check("popup list on an older Notiq: unknown_op is passed to the popup", old28 && old28.error === "unknown_op", JSON.stringify(old28));
    await SW(`(chrome.tabs.query = globalThis.__realQuery, true)`);

    // The popup page itself, with chrome.runtime.sendMessage stubbed.
    const { targetId: pop3Target } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
    const { sessionId: pop3 } = await cdp("Target.attachToTarget", { targetId: pop3Target, flatten: true });
    await cdp("Runtime.enable", {}, pop3);
    await sleep(600);
    const P3 = (e) => evalIn(pop3, e);
    const stub = (replies) => P3(`(() => {
      window.__sent = [];
      const R = ${JSON.stringify(replies)};
      const fake = (m, cb) => { window.__sent.push(m); setTimeout(() => cb && cb(R[m.type] || { error: "x" }), 30); };
      try { chrome.runtime.sendMessage = fake; } catch {}
      if (chrome.runtime.sendMessage !== fake) Object.defineProperty(chrome.runtime, "sendMessage", { value: fake, configurable: true, writable: true });
      window.close = () => { window.__closed = true; };
      return true;
    })()`);
    await stub({ list: { ok: true, host: "localhost", accounts: ACC }, copy: { ok: true, copied: "password", clearAfter: 30 }, popupFill: { ok: true }, open: { ok: true } });
    await cdp("Target.activateTarget", { targetId: pop3Target });
    await P3(`(document.activeElement && document.activeElement.blur && document.activeElement.blur(), setStatus("on", "Notiq unlocked"), loadSite("on"), true)`);
    const rows3 = () => P3(`({ rows: [...document.querySelectorAll("#accList li")].map((li) => ({ t: li.querySelector(".t").textContent, u: li.querySelector(".u").textContent,
      labels: [...li.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")), code: li.querySelector('[data-action="code"]').disabled })),
      imgs: document.querySelectorAll("#accList img").length, title: document.getElementById("siteHost").textContent,
      filterShown: !document.getElementById("filter").hidden, focus: document.activeElement && document.activeElement.id, state: document.getElementById("siteState").textContent })`);
    const r3 = await waitFor(async () => { const s = await rows3(); return s.rows.length === 2 && s; }, 3000) || await rows3();
    check("popup list: two rows (title + username as text), filter box shown and focused, host in the site chip",
      r3.rows.length === 2 && r3.rows[0].t === "Work" && r3.rows[1].t.startsWith("<img") && r3.imgs === 0 && r3.filterShown && r3.focus === "filter" && r3.title === "localhost",
      JSON.stringify(r3));
    check("popup list: every control has an accessible name; 2FA copy disabled without a code",
      r3.rows[0].labels.join("|") === "Fill Work (alice@work.com)|Copy username of Work|Copy password of Work|Copy 2FA code of Work|Open Work in Notiq" &&
      r3.rows[0].code === false && r3.rows[1].code === true, JSON.stringify(r3.rows));
    await P3(`(() => { const f = document.getElementById("filter"); f.value = "HOME"; f.dispatchEvent(new Event("input")); return true; })()`);
    const f3 = await rows3();
    check("popup filter narrows the site's logins (title or username)", f3.rows.length === 1 && f3.rows[0].u === "alice@home.com", JSON.stringify(f3.rows));
    await P3(`(() => { const f = document.getElementById("filter"); f.value = "zzz"; f.dispatchEvent(new Event("input")); return true; })()`);
    const z3 = await rows3();
    check("popup filter with no match says so", z3.rows.length === 0 && /No logins match/.test(z3.state), JSON.stringify(z3));
    await P3(`(() => { const f = document.getElementById("filter"); f.value = ""; f.dispatchEvent(new Event("input")); f.focus(); return true; })()`);
    const key = (k) => P3(`(document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })), true)`);
    const where = () => P3(`(() => { const a = document.activeElement; const li = a.closest && a.closest("li"); return { id: a.id, cls: a.className, action: a.dataset ? a.dataset.action || "" : "", row: li ? [...li.parentNode.children].indexOf(li) : -1 }; })()`);
    await key("ArrowDown");
    const k1 = await where();
    await key("ArrowDown");
    const k2 = await where();
    await key("ArrowRight"); await key("ArrowRight");
    const k3 = await where();
    await key("ArrowUp");
    const k4 = await where();
    await key("ArrowUp");
    const k5 = await where();
    check("popup keyboard: ↓ from the filter to the rows, ↓/↑ keep the column, → moves along a row, ↑ from the top row back to the filter",
      k1.cls === "acc-main" && k1.row === 0 && k2.row === 1 && k3.action === "password" && k3.row === 1 && k4.action === "password" && k4.row === 0 && k5.id === "filter",
      JSON.stringify([k1, k2, k3, k4, k5]));
    await key("Enter");
    const s3 = await waitFor(async () => { const s = await P3("window.__sent"); return s.some((m) => m.type === "popupFill") && s; }, 2000);
    check("popup: Enter in the filter fills the first login (popupFill with its account)",
      s3 && s3.find((m) => m.type === "popupFill").account === "Logins/Work.nqv", JSON.stringify(s3));
    await P3(`(document.querySelector('#accList li [data-action="password"]').click(), true)`);
    const cm3 = await waitFor(async () => { const t = await P3(`document.getElementById("msg").textContent`); return /copied/.test(t) && t; }, 2000);
    const sentCopy = (await P3("window.__sent")).find((m) => m.type === "copy");
    check("popup copy button: asks the app to copy (no value in the popup), says when it clears",
      sentCopy && sentCopy.what === "password" && sentCopy.account === "Logins/Work.nqv" && cm3 === "Password copied by Notiq. Clears in 30 s.", JSON.stringify({ sentCopy, cm3 }));
    await P3(`(document.querySelector('#accList li [data-action="open"]').click(), true)`);
    check("popup open button: sends open and closes the popup", await waitFor(() => P3("window.__closed === true && window.__sent.some((m) => m.type === 'open')"), 2000));
    // An older Notiq: the list and the actions say to update it.
    await stub({ list: { error: "unknown_op", host: "localhost" }, copy: { error: "unknown_op" } });
    await P3(`(loadSite("on"), true)`);
    const o3 = await waitFor(async () => { const t = await P3(`document.getElementById("siteState").textContent`); return /Update Notiq/.test(t) && t; }, 2000);
    check("popup on an older Notiq: 'Update Notiq to see your logins…', no rows", o3 && (await rows3()).rows.length === 0, String(o3));
    // Locked: no list request at all.
    await stub({ list: { ok: true, accounts: ACC } });
    await P3(`(loadSite("locked"), true)`);
    await sleep(150);
    const lk3 = await P3(`({ sent: window.__sent.length, state: document.getElementById("siteState").textContent, rows: document.querySelectorAll("#accList li").length })`);
    check("popup with a locked vault asks for nothing and says to unlock", lk3.sent === 0 && lk3.rows === 0 && /Unlock Notiq/.test(lk3.state), JSON.stringify(lk3));
    if (process.env.NOTIQ_POPUP_SHOT) {
      await stub({ list: { ok: true, host: "accounts.example.com", accounts: [ACC[0], { ...ACC[1], title: "Home" }, { account: "x", title: "Shared family login with a long name", username: "family@example.com", totp: true }] } });
      await P3(`(setStatus("on", "Notiq unlocked"), loadSite("on"), true)`);
      await cdp("Page.enable", {}, pop3);
      await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 760, deviceScaleFactor: 2, mobile: false }, pop3);
      await sleep(300);
      const h = await P3(`Math.ceil(document.documentElement.getBoundingClientRect().height)`);
      const { data } = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 320, height: h, scale: 1 } }, pop3);
      writeFileSync(process.env.NOTIQ_POPUP_SHOT, Buffer.from(data, "base64"));
    }
    await cdp("Target.closeTarget", { targetId: pop3Target });
    await cdp("Target.activateTarget", { targetId });
  }

  // 30. Identities: address / contact forms, the in-page chooser, the right-click menu (own block scope)
  {
    const IDP = `http://localhost:${PORT}/test-pages/identity.html`;
    const IDENT = { ok: true, title: "Home", name: "Asha K Rao", email: "asha@example.com", phone: "+91 98765 43210",
      address1: "Flat 4B, Lake View Apts", address2: "MG Road, Indiranagar", city: "Bengaluru", state: "Karnataka", postal: "560038", country: "India" };
    const IDLIST = { ok: true, identities: [{ account: "Identities/Home.nqv", title: "Home" }, { account: "Identities/Office.nqv", title: "Office" }] };
    const idVals = (ids) => P(`(${JSON.stringify(ids)}).reduce((o, id) => (o[id] = document.getElementById(id).value, o), {})`);
    async function rightClick(id) {
      const r = await P(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.scrollIntoView({block:"center"}); const r = e.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y }, page);
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "right", clickCount: 1 }, page);
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "right", clickCount: 1 }, page);
      await key("Escape", "Escape", 27); // close the browser's own menu, if one opened
      await sleep(200);
    }
    // A click on one of our menu items, as chrome.contextMenus.onClicked delivers it (frame 0 of the test tab).
    // tab.url isn't visible to the worker in this harness (no activeTab grant): the click's pageUrl stands in.
    const menuClick = async (menuItemId, extra = {}) => SW(`chrome.tabs.query({ active: true }).then((tabs) => {
      const tab = tabs.find((t) => (t.url || "").includes("/test-pages/identity.html")) || tabs[0];
      return onMenuClick({ menuItemId: ${JSON.stringify(menuItemId)}, frameId: 0, editable: true, pageUrl: ${JSON.stringify(await P("location.href"))}, ...${JSON.stringify(extra)} }, tab).then(() => true);
    })`);

    await resetState();
    await mockNative({ ...NATIVE, fill_identity: IDENT, identities: IDLIST });
    await load(IDP);
    const ic28 = (await icons()) || [];
    // India form 6 (not the landmark / hidden / offscreen fields), token form 10, text-box form 5, login form 2,
    // newsletter 0.
    check("identity page: icons on the address forms' text fields, the login form keeps login icons only", ic28.length === 23, String(ic28.length));
    check("identity page: nothing sent to Notiq on load", (await calls()).length === 0);
    check("identity page: no icon on the landmark, the newsletter box or the hidden fields",
      !(await iconFor("in-landmark")) && !(await iconFor("n-email")) && !(await iconFor("f-alt")));
    let ii = await iconFor("in-name");
    check("identity page: the full-name field has a 'Fill identity with Notiq' icon", !!ii);
    await mouseClick(ii.x, ii.y);
    const m28 = await waitFor(() => menuInfo(), 3000);
    check("identity icon: lists the identity titles, then 'Choose in Notiq…'",
      m28 && m28.items.map((i) => i.label).join("|") === "Home|Office|Choose in Notiq…", JSON.stringify(m28 && m28.items));
    const c28a = (await calls()).map(bare);
    check("identity icon: only the titles were asked for (no values yet)", c28a.length === 1 && c28a[0].op === "identities", JSON.stringify(c28a));
    await mouseClick(m28.items[1].x, m28.items[1].y);
    await waitFor(async () => (await P(`document.getElementById("in-city").value`)) !== "", 3000);
    const c28b = (await calls()).map(bare);
    const fi = c28b.find((c) => c.op === "fill_identity");
    check("identity fill: fill_identity with the page host, its origin and the picked account",
      fi && fi.host === "localhost" && fi.origin === `http://localhost:${PORT}` && fi.account === "Identities/Office.nqv" && Object.keys(fi).length === 4,
      JSON.stringify(c28b));
    const v28 = await idVals(["in-country", "in-name", "in-mobile", "in-pin", "in-line1", "in-line2", "in-landmark", "in-city", "in-state", "in-hidden", "in-trap", "in-offscreen-ok"]);
    check("Indian form: name, 10-digit mobile, PIN, both lines, city, state and country filled",
      v28["in-name"] === "Asha K Rao" && v28["in-mobile"] === "9876543210" && v28["in-pin"] === "560038" &&
      v28["in-line1"] === "Flat 4B, Lake View Apts" && v28["in-line2"] === "MG Road, Indiranagar" && v28["in-city"] === "Bengaluru" &&
      v28["in-state"] === "KA" && v28["in-country"] === "IN", JSON.stringify(v28));
    check("Indian form: landmark, hidden, display:none and unrelated fields untouched",
      v28["in-landmark"] === "" && v28["in-hidden"] === "" && v28["in-trap"] === "" && v28["in-offscreen-ok"] === "", JSON.stringify(v28));
    check("Indian form: other forms on the page untouched", (await P(`document.getElementById("t-city").value + document.getElementById("f-name").value + document.getElementById("n-email").value`)) === "");
    check("Indian form: the page saw the country change", (await P("window.__countryChanges")) >= 1);
    const t28 = await waitFor(async () => (await icons()).find((i) => i.tip === "Filled"), 1500);
    check("identity fill: the icon says 'Filled'", !!t28);

    // Vault locked: no titles, so the icon goes straight to Notiq (which unlocks and asks); tagged fields.
    await resetCalls();
    await mockNative({ ...NATIVE, fill_identity: IDENT, identities: { error: "locked" } });
    ii = await iconFor("t-city");
    await mouseClick(ii.x, ii.y);
    await waitFor(async () => (await P(`document.getElementById("t-city").value`)) !== "", 3000);
    const c28c = (await calls()).map(bare);
    check("locked vault: titles refused, then one fill_identity without an account",
      c28c.length === 2 && c28c[0].op === "identities" && c28c[1].op === "fill_identity" && !("account" in c28c[1]), JSON.stringify(c28c));
    const v28t = await idVals(["t-email", "t-first", "t-last", "t-addr1", "t-addr2", "t-city", "t-zip", "t-state", "t-country", "t-phone"]);
    check("token form: given / family split, the country code for autocomplete=country, every field",
      v28t["t-email"] === "asha@example.com" && v28t["t-first"] === "Asha K" && v28t["t-last"] === "Rao" && v28t["t-addr1"] === "Flat 4B, Lake View Apts" &&
      v28t["t-addr2"] === "MG Road, Indiranagar" && v28t["t-city"] === "Bengaluru" && v28t["t-zip"] === "560038" && v28t["t-state"] === "Karnataka" &&
      v28t["t-country"] === "IN" && v28t["t-phone"] === "+91 98765 43210", JSON.stringify(v28t));

    // A text box for the address next to a locality field holds line 1 only.
    await mockNative({ ...NATIVE, fill_identity: IDENT, identities: IDLIST });
    ii = await iconFor("f-name");
    await mouseClick(ii.x, ii.y);
    const m28c = await waitFor(() => menuInfo(), 3000);
    await mouseClick(m28c.items[0].x, m28c.items[0].y);
    await waitFor(async () => (await P(`document.getElementById("f-address").value`)) !== "", 3000);
    const v28f = await idVals(["f-name", "f-phone", "f-pin", "f-locality", "f-address", "f-alt"]);
    check("text-box form: address box = line 1, locality = line 2, alternate phone untouched",
      v28f["f-address"] === "Flat 4B, Lake View Apts" && v28f["f-locality"] === "MG Road, Indiranagar" && v28f["f-phone"] === "9876543210" &&
      v28f["f-pin"] === "560038" && v28f["f-alt"] === "", JSON.stringify(v28f));

    // An older Notiq doesn't know the op.
    await resetState();
    await mockNative({ ...NATIVE, fill_identity: { error: "unknown_op" }, identities: { error: "unknown_op" } });
    await load(IDP);
    ii = await iconFor("in-city");
    await mouseClick(ii.x, ii.y);
    const e28 = await waitFor(async () => (await icons()).find((i) => i.cls.includes("error")), 3000);
    check("older Notiq: 'Update Notiq to use this.' and nothing filled", e28 && e28.tip === "Update Notiq to use this." && (await P(`document.getElementById("in-city").value`)) === "",
      JSON.stringify(e28));

    // Right-click menu.
    await resetState();
    await mockNative({ ...NATIVE, fill_identity: IDENT, identities: IDLIST });
    await load(IDP);
    await SW("(identityAt = 0, true)"); // the titles were just asked for above: drop the 15-second throttle
    check("menu: the contextMenus API is available to the background", await SW("!!MENUS && typeof onMenuClick === 'function'"));
    await rightClick("in-city");
    const stored = await waitFor(async () => { const s = await session(); return s.identityMenu && s.identityMenu.length === 2 ? s.identityMenu : null; }, 3000);
    check("menu: opening it on a field loads the identity titles (titles only) into session memory",
      !!stored && JSON.stringify(stored) === JSON.stringify(IDLIST.identities), JSON.stringify(await session()));
    check("menu: only the titles were asked for", (await calls()).map(bare).every((c) => c.op === "identities"));
    await rightClick("in-city");
    check("menu: re-opening within 15 s doesn't ask again", (await calls()).filter((c) => c.op === "identities").length === 1);
    await resetCalls();
    await menuClick("nq-identity:1");
    await waitFor(async () => (await P(`document.getElementById("in-city").value`)) !== "", 3000);
    const c28m = (await calls()).map(bare);
    check("menu 'Fill identity > Office': one fill_identity for that account, form filled",
      c28m.length === 1 && c28m[0].op === "fill_identity" && c28m[0].account === "Identities/Office.nqv" &&
      (await P(`document.getElementById("in-pin").value`)) === "560038", JSON.stringify(c28m));
    // Fill login on a field without any icon (the newsletter box): a temporary icon shows progress.
    await resetCalls();
    await rightClick("n-email");
    await menuClick("nq-login");
    const tmp = await waitFor(async () => iconFor("n-email"), 2000);
    check("menu 'Fill login' on an undetected field: a temporary progress icon", !!tmp);
    await waitFor(async () => (await P(`document.getElementById("n-email").value`)) !== "", 3000);
    const c28l = (await calls()).map(bare);
    check("menu 'Fill login': the normal login fill for the page host, into the clicked field",
      c28l.some((c) => c.op === "fill" && c.host === "localhost") && (await P(`document.getElementById("n-email").value`)) === "alice@example.com", JSON.stringify(c28l));
    const gone = await waitFor(async () => !(await iconFor("n-email")), 9000);
    check("menu 'Fill login': the temporary icon goes away afterwards", gone);
    // Generate password into the clicked field only, locally.
    await resetCalls();
    await rightClick("l-pass");
    await menuClick("nq-generate");
    const gp = await waitFor(async () => P(`document.getElementById("l-pass").value`), 2000);
    check("menu 'Generate password': a 20-character password in that field, nothing sent to Notiq",
      typeof gp === "string" && gp.length === 20 && (await calls()).length === 0, JSON.stringify({ len: gp && gp.length }));
    const gm = await menuInfo();
    check("menu 'Generate password': the usual confirmation menu", gm && /Strong password filled/.test(gm.text), JSON.stringify(gm && gm.text));
    await key("Escape", "Escape", 27);
    // "Choose identity…" opens the in-page chooser on the clicked field.
    await rightClick("f-name");
    await menuClick("nq-identity-choose");
    const mc = await waitFor(() => menuInfo(), 3000);
    check("menu 'Choose identity…': the in-page chooser on the clicked field", mc && mc.items.map((i) => i.label).join("|") === "Home|Office|Choose in Notiq…",
      JSON.stringify(mc && mc.items));
    await key("Escape", "Escape", 27);
    // Locking drops the titles from the menu.
    await mockNative({ ...NATIVE, fill_identity: { error: "locked" }, identities: { error: "locked" } });
    await resetCalls();
    await menuClick("nq-identity:0");
    const dropped = await waitFor(async () => { const s = await session(); return Array.isArray(s.identityMenu) && s.identityMenu.length === 0; }, 3000);
    check("menu: a 'locked' answer drops the identity titles", dropped, JSON.stringify(await session()));
    // A menu click for a frame on another site is ignored.
    await resetCalls();
    await menuClick("nq-login", { frameId: 3, frameUrl: "https://evil.example/" });
    await sleep(600);
    check("menu: a click from another site's frame is ignored", (await calls()).length === 0);
  }

  // 31. Password-reuse warning, "Hide Notiq on this site", toolbar fill into open shadow roots (own block scope)
  {
    const SALT = "07".repeat(32);
    const warnInfo = () => inShadow(`function () {
      const b = this.querySelector(".nq-warn:not(.out)");
      if (!b) return null;
      return { text: b.textContent, role: b.getAttribute("role"),
        buttons: [...b.querySelectorAll("button")].map((x) => { const r = x.getBoundingClientRect(); return { label: x.textContent, x: r.x + r.width / 2, y: r.y + r.height / 2 }; }) };
    }`);
    await resetState();
    await mockNative({ ...NATIVE, reuse_salt: { ok: true, salt: SALT }, reuse_check: { ok: true, site: "paypal.com" } });
    await load();
    check("reuse: nothing asked on page load", (await reuseCalls()).length === 0);
    await typeInto("s-pass", "short7!");
    await clickId("s-user"); // blur
    await sleep(800);
    check("reuse: a password under 8 characters is never checked", (await reuseCalls()).length === 0);
    await typeInto("s-pass", "PayPal-Secret-1");
    await sleep(300);
    check("reuse: nothing is checked while typing (only on blur / submit)", (await reuseCalls()).length === 0);
    await clickId("s-user"); // blur
    const w31 = await waitFor(warnInfo, 3000);
    const rc = await reuseCalls();
    const chk = rc.find((c) => c.op === "reuse_check");
    const hmac = await P(`(async () => { const k = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const m = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("PayPal-Secret-1")));
      return [...m.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(""); })()`);
    check("reuse: on blur the app gets the host and a 16-byte salted HMAC tag, never the password",
      chk && chk.host === "localhost" && chk.salt === SALT && chk.tag === hmac && JSON.stringify(rc).indexOf("PayPal-Secret-1") < 0 &&
      Object.keys(bare(chk)).sort().join() === "host,op,salt,tag", JSON.stringify(rc.map(bare)));
    check("reuse: the warning card names both sites, in the closed overlay",
      w31 && w31.role === "alertdialog" && w31.text.includes("This is your password for paypal.com. This site is localhost. Check the address before you continue.") &&
      w31.buttons.map((b) => b.label).join("|") === "Leave this site|It's OK, I trust this site", JSON.stringify(w31));
    await clickId("s-pass");
    await clickId("s-user");
    await sleep(600);
    check("reuse: the same password is checked once per page", (await reuseCalls()).filter((c) => c.op === "reuse_check").length === 1);
    await inShadow(`function () { const b = [...this.querySelectorAll(".nq-warn button")].pop(); b.click(); }`);
    await sleep(500);
    check("reuse: a synthetic click on the card's buttons is ignored", !!(await warnInfo()) && !(await local()).reuseTrusted);
    const trustBtn = w31 && w31.buttons[1];
    if (trustBtn) await mouseClick(trustBtn.x, trustBtn.y);
    const trusted = await waitFor(async () => { const l = await local(); return Array.isArray(l.reuseTrusted) && l.reuseTrusted.includes("localhost"); }, 2000);
    check("reuse: 'It's OK, I trust this site' remembers the site and closes the card", trusted && !!(await waitFor(async () => !(await warnInfo()), 1000)), JSON.stringify(await local()));
    await resetCalls();
    await typeInto("s-pass", "Another-Secret-2");
    await clickId("s-user");
    await sleep(800);
    check("reuse: a trusted site is never checked again", (await reuseCalls()).length === 0);
    // A locked vault (the background may still hold this app run's salt): Notiq answers locked, nothing is shown.
    await resetState();
    await mockNative({ ...NATIVE, reuse_salt: { error: "locked" }, reuse_check: { error: "locked" } });
    await load();
    await typeInto("s-pass", "PayPal-Secret-1");
    await clickId("s-user");
    await sleep(900);
    check("reuse: a locked vault shows nothing", !(await warnInfo()) && (await reuseCalls()).length >= 1, JSON.stringify((await reuseCalls()).map(bare)));
    // Submit (Enter) checks too; "Leave this site" navigates the tab away.
    await resetState();
    await mockNative({ ...NATIVE, reuse_salt: { ok: true, salt: SALT }, reuse_check: { ok: true, site: "paypal.com" } });
    await load();
    await typeInto("s-pass", "PayPal-Secret-1");
    await pressEnter();
    const w31b = await waitFor(warnInfo, 3000);
    check("reuse: submitting the form checks too", !!w31b);
    if (w31b) await mouseClick(w31b.buttons[0].x, w31b.buttons[0].y);
    const left = await waitFor(async () => (await P("location.href").catch(() => "")) === "about:blank", 3000);
    check("reuse: 'Leave this site' leaves the page", left);

    // "Hide Notiq on this site": the icon's own menu (right-click on the icon).
    await resetState();
    await mockNative(NATIVE);
    await load();
    check("hide: 6 icons before", ((await icons()) || []).length === 6);
    const hi = await iconFor("s-pass");
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: hi.x, y: hi.y }, page);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: hi.x, y: hi.y, button: "right", clickCount: 1 }, page);
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: hi.x, y: hi.y, button: "right", clickCount: 1 }, page);
    const hm = await waitFor(menuInfo, 1500);
    check("hide: right-click on the icon opens its menu (fill, hide)",
      hm && hm.items.map((i) => i.label).join("|") === "Fill with Notiq|Hide Notiq on this site", JSON.stringify(hm && hm.items));
    check("hide: opening the icon menu sends nothing to Notiq", (await calls()).length === 0);
    if (hm) await mouseClick(hm.items[1].x, hm.items[1].y);
    const hidden = await waitFor(async () => { const l = await local(); return Array.isArray(l.hiddenSites) && l.hiddenSites.join() === "localhost"; }, 2000);
    check("hide: the top host is stored in hiddenSites", hidden, JSON.stringify(await local()));
    check("hide: every icon goes away", await waitFor(async () => ((await icons()) || []).length === 0, 2000));
    await load();
    check("hide: still hidden after a reload", ((await icons()) || []).length === 0);
    // Alt+Shift+L (the command sends fillShortcut) still fills there.
    await clickId("s-pass");
    await SW(`chrome.tabs.query({}).then((tabs) => { const t = tabs.find((x) => (x.url || "").includes("/test-pages/login.html")) || tabs.find((x) => x.active);
      return chrome.tabs.sendMessage(t.id, { type: "fillShortcut" }).catch(() => null).then(() => true); })`);
    await waitFor(async () => (await P(`document.getElementById("s-pass").value`)) !== "", 3000);
    const hv = await P(`({ u: document.getElementById("s-user").value, p: document.getElementById("s-pass").value })`);
    const hc = await calls();
    check("hide: Alt+Shift+L still fills on a hidden site", hv.u === "alice@example.com" && hv.p === "Notiq-Filled-1!" && hc.length === 1 && hc[0].op === "fill", JSON.stringify({ hv, hc }));
    await sleep(6000); // the temporary progress icon goes away
    check("hide: the shortcut's temporary icon goes away", ((await icons()) || []).length === 0);
    await SW(`chrome.storage.local.set({ hiddenSites: [] }).then(() => true)`);
    check("hide: removing the site (popup ×) brings the icons back", await waitFor(async () => ((await icons()) || []).length === 6, 2500));

    // Toolbar fill (probeFrame + fillPage) into open shadow roots, run as the injection runs them.
    const PROBE = await SW("probeFrame.toString()");
    const FILLPAGE2 = await SW("fillPage.toString()");
    await load(SHADOW);
    await sleep(1500);
    const pr = await P(`(${PROBE})()`);
    check("toolbar probe: fields inside open shadow roots count", pr && pr.fields === true && pr.password === true, JSON.stringify(pr));
    const nf = await P(`(${FILLPAGE2})("localhost", { username: "tool@example.com", password: "Tool-Shadow-1" }, { top: location.origin, allowed: [location.origin] })`);
    check("toolbar fill: username and password go into the first open-root form",
      nf >= 2 && (await shadowVal(["#c1", "#c1-user"])) === "tool@example.com" && (await shadowVal(["#c1", "#c1-pass"])) === "Tool-Shadow-1", String(nf));
    check("toolbar fill: the closed root stays closed", await P(`document.getElementById("c4").shadowRoot === null`));
  }

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  console.error("ERROR", e && e.stack || e);
} finally {
  try { ws && ws.close(); } catch {}
  chrome.kill();
  server.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(exitCode);
}
