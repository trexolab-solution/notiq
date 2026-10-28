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
      const r = globalThis.__reply[msg.op] || { error: "app_not_running" };
      setTimeout(() => cb(r), 300);
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
  check("manifest version 0.2.0 with storage permission and top-frame content script",
    manifest.version === "0.2.0" && manifest.permissions.includes("storage") && manifest.content_scripts[0].all_frames === false);

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
