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
import { mkdtempSync, readdirSync, existsSync, rmSync } from "node:fs";
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
const calls = () => SW("globalThis.__calls || []");
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
  await SW(`chrome.storage.session.clear().then(() => chrome.storage.local.clear()).then(() => chrome.storage.local.set(${JSON.stringify(settings)})).then(() => true)`);
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
  check("manifest version 0.3.0 with storage permission and all-frames content script (same-site gated)",
    manifest.version === "0.3.0" && manifest.permissions.includes("storage") && manifest.content_scripts[0].all_frames === true &&
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
    Object.keys(c2[0]).sort().join() === "host,op,password,title,url,username", JSON.stringify(c2.map((c) => ({ ...c, password: "<redacted>" }))));
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
    c16.length === 1 && c16[0].op === "save" && c16[0].password === "New-Pw-22" && Object.keys(c16[0]).sort().join() === "host,op,password,title,url,username");

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
    chrome.scripting.executeScript = async (o) => { globalThis.__injected.push({ allFrames: o.target.allFrames, func: o.func.name, args: o.args }); return [{ frameId: 0, result: 1 }]; };
    return true;
  })()`);
  const t20 = await SW("fillActiveTab()");
  check("toolbar fill returns the chooser list (no secrets)", t20 && Array.isArray(t20.choose) && t20.choose.length === 2 && !JSON.stringify(t20).includes("Pw"), JSON.stringify(t20));
  const t20b = await SW(`fillActiveTab("acc-work")`);
  const inj = await SW("globalThis.__injected");
  const c20 = await calls();
  check("toolbar re-send with account injects fillPage with that login for the tab host",
    t20b && t20b.ok && c20.length === 2 && c20[1].account === "acc-work" && inj.length === 1 && inj[0].func === "fillPage" && inj[0].allFrames === true &&
    inj[0].args[0] === "localhost" && inj[0].args[1].password === "Work-Pw-8", JSON.stringify({ t20b, n: c20.length }));
  const t20c = await SW(`fillActiveTab("acc-work")`);
  check("an account can be used once per offer (replay refused)", t20c && t20c.error === "stale", JSON.stringify(t20c));
  // fillPage's own logic (what the injection runs), executed in the page.
  const FILLPAGE = await SW("fillPage.toString()");
  await load(EXTRA);
  await P(`document.getElementById("change").hidden = true`);
  const fp = await P(`(${FILLPAGE})("localhost", { username: "u@example.com", password: "Tool-Pw-1", code: "135790" })`);
  const fpv = await P(`({ u: document.getElementById("m-user").value, p: document.getElementById("m-pass").value,
    code: [1,2,3,4,5,6].map((k) => document.getElementById("o" + k).value).join(""), active: document.activeElement.id })`);
  check("toolbar fillPage fills login + split OTP boxes", fp === 3 && fpv.u === "u@example.com" && fpv.p === "Tool-Pw-1" && fpv.code === "135790" && fpv.active === "o6", JSON.stringify({ fp, ...fpv, p: "<redacted>" }));
  const fpOther = await P(`(${FILLPAGE})("example.com", { username: "x", password: "y" })`);
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
