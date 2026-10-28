// Notiq Autofill — content script (top frame only).
//
// 1. Detects login fields and puts a small Notiq icon inside them. Clicking the
//    icon (a real, trusted user click only) asks the background to fill; the
//    Notiq app still asks the user to Allow. Nothing is requested on page load,
//    so the icon never reveals whether the vault has a login for this site.
// 2. Notices a submitted login and, once the page no longer shows a password
//    field, offers "Save login to Notiq?". Saving again needs approval in Notiq.
//
// Everything visible lives in ONE closed shadow root, so page CSS/JS cannot
// read or restyle it. No secret is ever written to the page DOM, a page-visible
// object, window.postMessage or the console.
(() => {
  "use strict";
  if (window.top !== window) return;

  const isLocalHost = (h) => h === "localhost" || h === "127.0.0.1";
  const pageHost = () => String(location.hostname || "").toLowerCase();
  const pageSecure = () =>
    location.protocol === "https:" || (location.protocol === "http:" && isLocalHost(pageHost()));
  if (!pageSecure()) return;

  // Same wording as popup.js, plus the save-specific errors.
  const TEXT = {
    app_not_running: "Notiq isn't running. Open the app and try again.",
    no_host: "Notiq isn't set up for this browser yet. Start the Notiq app once, then restart the browser.",
    locked: "The vault is locked. Unlock it in Notiq, then try again.",
    denied: "You declined in Notiq.",
    no_match: "No saved login for this site in your vault.",
    timeout: "No answer from Notiq in time.",
    not_https: "Autofill only works on secure (https) pages.",
    no_fields: "Couldn't find a login form on this page.",
    bad_request: "Notiq couldn't read this login.",
    expired: "This save offer expired.",
    busy: "Notiq is already waiting for your approval.",
    no_reply: "Notiq didn't answer. Reload the page and try again.",
  };
  const GENERIC = "Something went wrong.";
  const SAVE_TEXT = { saved: "Saved to Notiq", updated: "Password updated in Notiq", unchanged: "Already saved" };
  const RETRYABLE = new Set(["locked", "timeout", "app_not_running", "no_host", "no_reply", "busy"]);

  const ICON = 18, MIN_W = 120, MIN_H = 16;
  const MAX_PW = 1024, MAX_USER = 512;
  const USER_TTL = 5 * 60 * 1000, BAR_IDLE = 25 * 1000, DEDUPE_MS = 3000;
  const LOGIN_PATH = /login|signin|sign-in|sso|auth/i;
  const USER_HINT = /user|email|login|account/i;
  const OTP_HINT = /otp|totp|2fa|mfa|verification|security.?code|one.?time/i;
  const SUBMIT_TEXT = /log ?in|sign ?in|sign ?up|continue|next|submit|register|create|save|change|update|enter|weiter|anmelden/i;

  const settings = { offerSave: true, showIcon: true, neverSave: [] };
  let filled = null;   // { username, password } that Notiq just put on this page (memory only)
  let lastUser = null; // { host, value, at } last username typed here (multi-step flows)
  let lastSent = null; // { username, password, at } dedupe of capture messages

  // ---------- messaging ----------
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ error: "no_reply" });
          else resolve(res && typeof res === "object" ? res : { error: "no_reply" });
        });
      } catch {
        resolve({ error: "no_reply" }); // extension was reloaded; this script is orphaned
      }
    });
  }
  const errText = (code) => (typeof code === "string" && Object.prototype.hasOwnProperty.call(TEXT, code) ? TEXT[code] : GENERIC);

  // ---------- field helpers ----------
  const attr = (el, n) => String((el.getAttribute && el.getAttribute(n)) || "");
  const typeOf = (el) => String(el.type || "text").toLowerCase();
  const isInput = (el) => !!el && el.tagName === "INPUT";
  const isPassword = (el) => isInput(el) && typeOf(el) === "password";
  const isTextual = (el) => isInput(el) && ["text", "email", "tel"].includes(typeOf(el));
  const hintOf = (el) => `${el.name || ""} ${el.id || ""} ${attr(el, "placeholder")}`;
  const acOf = (el) => attr(el, "autocomplete").toLowerCase().split(/\s+/);
  const isOtp = (el) => acOf(el).includes("one-time-code") || OTP_HINT.test(hintOf(el));
  function isUserLike(el) {
    if (!isTextual(el) || isOtp(el)) return false;
    const ac = acOf(el);
    return ac.includes("username") || ac.includes("email") || typeOf(el) === "email" || USER_HINT.test(hintOf(el));
  }
  const precedes = (a, b) => !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING);
  const inputsIn = (scope) => Array.from((scope || document).querySelectorAll("input"));

  function shown(el, minW = 1, minH = 1) {
    if (!el || !el.isConnected || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < minW || r.height < minH) return false;
    let n = el;
    for (let depth = 0; n && n.nodeType === 1 && depth < 12; depth++, n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || parseFloat(cs.opacity) === 0) return false;
      if (depth === 0 && (cs.visibility === "hidden" || cs.visibility === "collapse")) return false;
    }
    return !(el.closest && el.closest('[aria-hidden="true"]'));
  }
  const usable = (el) => shown(el, MIN_W, MIN_H) && !el.readOnly;

  // The form, or for formless (SPA) password fields the closest ancestor that also holds another input.
  function scopeOf(field) {
    if (field.form) return field.form;
    let n = field.parentElement;
    for (let i = 0; n && i < 6; i++, n = n.parentElement) {
      if (inputsIn(n).some((x) => x !== field && isTextual(x))) return n;
    }
    return field.parentElement || document;
  }

  // ---------- detection ----------
  function detect() {
    const out = new Set();
    for (const pw of inputsIn(document)) {
      if (!isPassword(pw) || !usable(pw)) continue;
      out.add(pw);
      for (const i of inputsIn(scopeOf(pw))) if (i !== pw && isUserLike(i) && usable(i)) out.add(i);
    }
    // Username-first flows: the only text field of a form on a login-looking URL.
    if (LOGIN_PATH.test(location.pathname)) {
      for (const form of Array.from(document.forms || [])) {
        const ins = inputsIn(form);
        if (ins.some((i) => isPassword(i) && shown(i))) continue;
        const texts = ins.filter((i) => isTextual(i) && shown(i));
        if (texts.length === 1 && isUserLike(texts[0]) && usable(texts[0])) out.add(texts[0]);
      }
    }
    return out;
  }
  const anyVisiblePassword = () => inputsIn(document).some((i) => isPassword(i) && shown(i));

  // ---------- overlay (one closed shadow root) ----------
  const CSS = `
:host { all: initial; }
.nq-wrap { position: fixed; width: ${ICON}px; height: ${ICON}px; pointer-events: none; }
.nq-icon { all: initial; box-sizing: border-box; position: absolute; inset: 0; width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center; border-radius: 5px; cursor: pointer;
  pointer-events: auto; background: #1c1b18; color: #c9a84c; opacity: .92;
  box-shadow: 0 0 0 1px rgba(201,168,76,.6), 0 1px 3px rgba(0,0,0,.35); transition: opacity .15s, transform .15s; }
.nq-icon:hover { opacity: 1; transform: scale(1.08); }
.nq-icon:focus-visible { outline: 2px solid #c9a84c; outline-offset: 2px; }
.nq-icon svg { width: 12px; height: 12px; display: block; }
.nq-spin { display: none; width: 9px; height: 9px; border-radius: 50%; border: 2px solid rgba(201,168,76,.3);
  border-top-color: #c9a84c; animation: nq-rot .8s linear infinite; }
.nq-ok, .nq-err { display: none !important; }
.waiting .nq-key, .done .nq-key, .error .nq-key { display: none; }
.waiting .nq-spin { display: block; }
.done .nq-ok, .error .nq-err { display: block !important; }
.done .nq-icon { color: #7bd88f; }
.error .nq-icon { color: #f0a35e; box-shadow: 0 0 0 1px rgba(240,163,94,.7), 0 1px 3px rgba(0,0,0,.35); }
.nq-tip { display: none; position: absolute; top: ${ICON + 6}px; right: 0; width: max-content; max-width: 240px;
  padding: 6px 9px; border-radius: 7px; background: #1c1b18; color: #f3efe4; border: 1px solid rgba(201,168,76,.4);
  font: 500 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 6px 18px rgba(0,0,0,.35); }
.has-tip .nq-tip { display: block; }
.nq-bar { box-sizing: border-box; position: fixed; top: 16px; right: 16px; width: 360px; max-width: calc(100vw - 32px);
  pointer-events: auto; background: #1c1b18; color: #f3efe4; border: 1px solid rgba(201,168,76,.32);
  border-left: 3px solid #c9a84c; border-radius: 12px; padding: 14px 14px 12px;
  box-shadow: 0 14px 36px rgba(0,0,0,.45); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  animation: nq-in .22s ease-out; }
.nq-bar.out { opacity: 0; transform: translateY(-6px); transition: opacity .18s, transform .18s; }
.nq-head { display: flex; gap: 10px; align-items: center; min-width: 0; }
.nq-logo { flex: none; width: 30px; height: 30px; border-radius: 8px; background: rgba(201,168,76,.14); color: #c9a84c;
  display: flex; align-items: center; justify-content: center; }
.nq-logo svg { width: 16px; height: 16px; }
.nq-text { min-width: 0; }
.nq-title { font-weight: 650; font-size: 14px; }
.nq-sub { font-size: 12px; opacity: .72; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nq-status { display: none; margin-top: 10px; font-size: 12.5px; align-items: center; gap: 8px; }
.nq-status.show { display: flex; }
.nq-status.err { color: #f0a35e; }
.nq-status.ok { color: #7bd88f; }
.nq-status .nq-spin { display: block; flex: none; }
.nq-actions { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
.nq-btn { all: initial; box-sizing: border-box; font: 600 12.5px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 8px 12px; border-radius: 8px; cursor: pointer; color: #f3efe4; border: 1px solid rgba(243,239,228,.2); }
.nq-btn:hover { border-color: rgba(243,239,228,.45); }
.nq-btn:focus-visible { outline: 2px solid #c9a84c; outline-offset: 2px; }
.nq-primary { background: #c9a84c; color: #1c1b18; border-color: #c9a84c; }
.nq-primary:hover { background: #d6b75e; border-color: #d6b75e; }
.nq-quiet { margin-left: auto; border-color: transparent; opacity: .72; font-weight: 500; }
.nq-quiet:hover { opacity: 1; border-color: transparent; text-decoration: underline; }
@keyframes nq-rot { to { transform: rotate(360deg); } }
@keyframes nq-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .nq-icon, .nq-bar, .nq-bar.out { animation: none !important; transition: none !important; }
  .nq-icon:hover { transform: none; }
  .nq-spin { animation: none !important; border-color: #c9a84c; border-style: dotted; }
}`;

  let shadowHost = null, root = null;
  function ensureRoot() {
    if (!shadowHost) {
      shadowHost = document.createElement("div");
      const s = shadowHost.style;
      const set = (k, v) => s.setProperty(k, v, "important");
      set("all", "initial");
      set("position", "fixed"); set("top", "0"); set("left", "0"); set("width", "0"); set("height", "0");
      set("overflow", "visible"); set("z-index", "2147483647"); set("pointer-events", "none"); set("display", "block");
      root = shadowHost.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = CSS;
      root.appendChild(style);
    }
    if (!shadowHost.isConnected) document.documentElement.appendChild(shadowHost);
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svg(cls, paths) {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2.4");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    if (cls) s.setAttribute("class", cls);
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, d.startsWith("C") ? "circle" : "path");
      if (d.startsWith("C")) {
        const [cx, cy, r] = d.slice(1).split(",");
        p.setAttribute("cx", cx); p.setAttribute("cy", cy); p.setAttribute("r", r);
      } else p.setAttribute("d", d);
      s.appendChild(p);
    }
    return s;
  }
  const KEY = ["C7.5,15.5,4.5", "M10.7 12.3 20 3", "M16.5 6.5l3 3", "M14 9l2 2"];
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ---------- inline icons ----------
  const icons = new Map(); // field -> { wrap, btn, tip, timer }
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => schedulePosition()) : null;
  let filling = false;

  function addIcon(field) {
    ensureRoot();
    const wrap = el("div", "nq-wrap");
    const btn = el("button", "nq-icon");
    btn.type = "button";
    btn.tabIndex = -1; // keyboard users have Alt+Shift+L; don't hijack the page's tab order
    btn.title = "Fill with Notiq";
    btn.setAttribute("aria-label", "Fill with Notiq");
    btn.appendChild(svg("nq-key", KEY));
    btn.appendChild(el("span", "nq-spin"));
    btn.appendChild(svg("nq-ok", ["M5 12.5l4.5 4.5L19 7.5"]));
    btn.appendChild(svg("nq-err", ["M12 6v8", "M12 18v.5"]));
    const tip = el("div", "nq-tip");
    tip.setAttribute("role", "status");
    wrap.appendChild(btn);
    wrap.appendChild(tip);
    // Keep focus in the field; only a real user click may start a fill.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isTrusted !== true) return;
      onIconClick(field);
    });
    root.appendChild(wrap);
    icons.set(field, { wrap, btn, tip, timer: 0 });
    if (ro) ro.observe(field);
  }
  function removeIcon(field) {
    const ic = icons.get(field);
    if (!ic) return;
    clearTimeout(ic.timer);
    ic.wrap.remove();
    icons.delete(field);
    if (ro) ro.unobserve(field);
  }
  const clearIcons = () => { for (const f of Array.from(icons.keys())) removeIcon(f); };

  function setState(field, state, text) {
    const ic = icons.get(field);
    if (!ic) return;
    clearTimeout(ic.timer);
    ic.wrap.className = `nq-wrap ${state}${text ? " has-tip" : ""}`;
    ic.tip.textContent = text || "";
    ic.btn.setAttribute("aria-label", text ? `Fill with Notiq: ${text}` : "Fill with Notiq");
    if (state === "done" || state === "error") {
      ic.timer = setTimeout(() => setState(field, "idle", ""), state === "done" ? 1800 : 5000);
    }
  }

  let rafPending = false;
  function schedulePosition() {
    if (rafPending || !icons.size) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; positionAll(); });
  }
  function positionAll() {
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const [field, ic] of Array.from(icons)) {
      if (!field.isConnected) { removeIcon(field); continue; }
      const r = field.getBoundingClientRect();
      const onScreen = r.width >= MIN_W && r.height >= MIN_H && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      if (!onScreen) { ic.wrap.style.display = "none"; continue; }
      const size = Math.max(12, Math.min(ICON, r.height - 4));
      const pad = Math.min(8, Math.max(3, (r.height - size) / 2));
      ic.wrap.style.display = "block";
      ic.wrap.style.width = ic.wrap.style.height = `${size}px`;
      ic.wrap.style.left = `${Math.round(r.right - size - pad)}px`;
      ic.wrap.style.top = `${Math.round(r.top + (r.height - size) / 2)}px`;
    }
  }

  function scan() {
    if (!settings.showIcon) { clearIcons(); return; }
    const found = detect();
    for (const f of Array.from(icons.keys())) if (!found.has(f)) removeIcon(f);
    for (const f of found) if (!icons.has(f)) addIcon(f);
    schedulePosition();
  }

  // ---------- fill (only after a trusted click on our icon) ----------
  function setValue(input, value) {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
    input.focus();
    if (d && d.set) d.set.call(input, value); else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function fillFields(anchor, cred) {
    let pw = isPassword(anchor) ? anchor : inputsIn(anchor.form || scopeOf(anchor)).find((i) => isPassword(i) && usable(i)) || null;
    let n = 0;
    if (pw) {
      const before = inputsIn(scopeOf(pw)).filter((i) => i !== pw && isTextual(i) && !isOtp(i) && shown(i) && !i.readOnly && precedes(i, pw));
      const user = !isPassword(anchor) ? anchor : before[before.length - 1] || null;
      if (user && cred.username) { setValue(user, cred.username); n++; }
      setValue(pw, cred.password); n++;
    } else if (cred.username) {
      setValue(anchor, cred.username); n++;
    }
    if (cred.code) {
      const otp = inputsIn(document).find((i) => isTextual(i) && isOtp(i) && shown(i) && !i.readOnly);
      if (otp) { setValue(otp, cred.code); n++; }
    }
    if (n) filled = { username: cred.username || "", password: cred.password || "" };
    return n;
  }
  async function onIconClick(field) {
    if (filling) return;
    filling = true;
    setState(field, "waiting", "Approve in Notiq");
    const res = await send({ type: "fill" });
    filling = false;
    if (res.ok && typeof res.password === "string" && res.host === pageHost() && field.isConnected) {
      const n = fillFields(field, {
        username: typeof res.username === "string" ? res.username : "",
        password: res.password,
        code: typeof res.code === "string" ? res.code : "",
      });
      setState(field, n ? "done" : "error", n ? "Filled" : TEXT.no_fields);
    } else {
      setState(field, "error", res.ok ? GENERIC : errText(res.error));
    }
  }

  // ---------- capture of submitted logins ----------
  const clean = (s, max) => String(s || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const cleanUrl = () => clean(location.origin + location.pathname, 2048);

  function rememberUser(value) {
    const v = clean(value, MAX_USER);
    if (v) lastUser = { host: pageHost(), value: v, at: Date.now() };
  }
  function recentUser() {
    return lastUser && lastUser.host === pageHost() && Date.now() - lastUser.at < USER_TTL ? lastUser.value : "";
  }
  function pickPassword(pws) {
    const fresh = pws.filter((i) => acOf(i).includes("new-password"));
    if (fresh.length) return fresh[0];
    if (pws.length >= 3) return pws[1];                     // current, new, confirm
    if (pws.length === 2) return pws[0].value === pws[1].value ? pws[0] : pws[1]; // new+confirm / current+new
    return pws[0];
  }

  // Returns the payload it sent (for tests) or null when skipped.
  function capture(scope) {
    if (!settings.offerSave || !pageSecure()) return null;
    const host = pageHost();
    if (!host || settings.neverSave.includes(host)) return null;
    const ins = inputsIn(scope);
    const pws = ins.filter((i) => isPassword(i) && i.value && shown(i));
    if (!pws.length) {
      const u = ins.find((i) => isUserLike(i) && i.value && shown(i));
      if (u) rememberUser(u.value);
      return null;
    }
    const pw = pickPassword(pws);
    const password = String(pw.value);
    if (!password || password.length > MAX_PW) return null;
    const before = ins.filter((i) => isTextual(i) && !isOtp(i) && i.value && shown(i) && precedes(i, pws[0]));
    const hiddenUser = ins.find((i) => isInput(i) && acOf(i).includes("username") && i.value && !isPassword(i));
    const username = clean((before.length && before[before.length - 1].value) || (hiddenUser && hiddenUser.value) || recentUser(), MAX_USER);
    if (filled && password === filled.password && (!username || username === filled.username)) return null;
    const now = Date.now();
    if (lastSent && lastSent.password === password && lastSent.username === username && now - lastSent.at < DEDUPE_MS) return null;
    lastSent = { username, password, at: now };
    if (username) rememberUser(username);
    const payload = { host, url: cleanUrl(), username, password, title: clean(document.title, 80) };
    send({ type: "capture", payload });
    // SPAs often don't navigate after login; look again once the form is gone.
    schedulePending(1500);
    setTimeout(() => schedulePending(0), 4500);
    return payload;
  }

  const realTarget = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
  function onSubmit(e) {
    if (e.isTrusted !== true) return;
    const form = e.target;
    if (form && form.tagName === "FORM") capture(form);
  }
  function onKeydown(e) {
    if (e.isTrusted !== true) return;
    if (e.key === "Escape" && bar) { closeBar(true); return; }
    if (e.key !== "Enter") return;
    const t = realTarget(e);
    if (isPassword(t)) capture(scopeOf(t));
    else if (isUserLike(t) && t.value) rememberUser(t.value);
  }
  function nearbyPassword(node) {
    let n = node.parentElement;
    for (let i = 0; n && i < 5; i++, n = n.parentElement) {
      const pw = inputsIn(n).find((x) => isPassword(x) && x.value && shown(x));
      if (pw) return pw;
    }
    return null;
  }
  function onClick(e) {
    if (e.isTrusted !== true) return;
    const t = realTarget(e);
    if (!t || !t.closest || t === shadowHost) return;
    const b = t.closest('button, input[type="submit"], input[type="image"], input[type="button"], [role="button"]');
    if (!b) return;
    const form = b.form || b.closest("form");
    const submitLike = (b.tagName === "BUTTON" && typeOf(b) === "submit") ||
      (isInput(b) && ["submit", "image"].includes(typeOf(b))) ||
      SUBMIT_TEXT.test(`${b.textContent || ""} ${b.value || ""} ${attr(b, "aria-label")}`);
    if (form) { if (submitLike) capture(form); return; }
    const pw = nearbyPassword(b);
    if (pw) capture(scopeOf(pw));
    else if (submitLike) {
      const u = inputsIn(document).find((i) => isUserLike(i) && i.value && shown(i));
      if (u) rememberUser(u.value);
    }
  }
  function onChange(e) {
    if (e.isTrusted !== true) return;
    const t = realTarget(e);
    if (isUserLike(t) && t.value) rememberUser(t.value);
  }

  // ---------- save bar ----------
  let bar = null, barIdle = 0, pendingTimer = 0;
  function schedulePending(delay) {
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(checkPending, delay);
  }
  async function checkPending() {
    if (bar || !settings.offerSave || anyVisiblePassword()) return;
    const res = await send({ type: "pending" });
    const p = res && res.pending;
    if (!p || typeof p.host !== "string" || typeof p.username !== "string") return;
    if (bar || !settings.offerSave || settings.neverSave.includes(p.host.toLowerCase()) || anyVisiblePassword()) return;
    showBar({ host: clean(p.host, 253).toLowerCase(), username: clean(p.username, MAX_USER) });
  }

  function armIdle() {
    clearTimeout(barIdle);
    barIdle = setTimeout(() => closeBar(true), BAR_IDLE);
  }
  function closeBar(dismiss) {
    if (!bar) return;
    clearTimeout(barIdle);
    const b = bar.node;
    bar = null;
    if (dismiss) send({ type: "dismiss" });
    b.classList.add("out");
    setTimeout(() => b.remove(), 200);
  }
  function showBar(p) {
    ensureRoot();
    const node = el("div", "nq-bar");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-live", "polite");
    node.setAttribute("aria-label", "Save login to Notiq");
    const head = el("div", "nq-head");
    const logo = el("div", "nq-logo");
    logo.appendChild(svg("", KEY));
    const text = el("div", "nq-text");
    text.appendChild(el("div", "nq-title", "Save login to Notiq?"));
    text.appendChild(el("div", "nq-sub", `${p.host} · ${p.username || "no username"}`));
    head.appendChild(logo);
    head.appendChild(text);
    const status = el("div", "nq-status");
    const statusText = el("span", "");
    const actions = el("div", "nq-actions");
    const mk = (label, cls, fn) => {
      const b = el("button", `nq-btn ${cls}`, label);
      b.type = "button";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.isTrusted !== true) return;
        fn();
      });
      return b;
    };
    const setStatus = (kind, msg, spin) => {
      status.textContent = "";
      if (spin) status.appendChild(el("span", "nq-spin"));
      statusText.textContent = msg;
      status.appendChild(statusText);
      status.className = `nq-status show ${kind}`;
    };
    const setActions = (...btns) => { actions.textContent = ""; for (const b of btns) actions.appendChild(b); };
    let saving = false;
    const doSave = async () => {
      if (saving) return;
      saving = true;
      clearTimeout(barIdle);
      setActions();
      setStatus("", "Waiting for approval in Notiq…", true);
      const res = await send({ type: "save" });
      saving = false;
      if (!bar || bar.node !== node) return;
      if (res.ok) {
        setStatus("ok", SAVE_TEXT[res.status] || SAVE_TEXT.saved, false);
        setTimeout(() => { if (bar && bar.node === node) closeBar(false); }, 2500);
        return;
      }
      setStatus("err", errText(res.error), false);
      const close = mk("Close", "", () => closeBar(true));
      if (RETRYABLE.has(res.error)) setActions(mk("Try again", "nq-primary", doSave), close);
      else setActions(close);
      armIdle();
    };
    setActions(
      mk("Save", "nq-primary", doSave),
      mk("Not now", "", () => closeBar(true)),
      mk("Never for this site", "nq-quiet", () => { send({ type: "never" }); closeBar(false); }),
    );
    node.appendChild(head);
    node.appendChild(status);
    node.appendChild(actions);
    for (const ev of ["pointermove", "focusin", "keydown"]) node.addEventListener(ev, () => { if (!saving) armIdle(); });
    root.appendChild(node);
    bar = { node };
    armIdle();
  }

  // ---------- messages from the extension (never from the page) ----------
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!sender || sender.id !== chrome.runtime.id || sender.tab) return false;
    if (msg && msg.type === "filled" && msg.host === pageHost() && typeof msg.password === "string") {
      filled = { username: typeof msg.username === "string" ? msg.username : "", password: msg.password };
    }
    return false;
  });

  // ---------- settings ----------
  function applySettings(s) {
    if ("offerSave" in s) settings.offerSave = s.offerSave !== false;
    if ("showIcon" in s) settings.showIcon = s.showIcon !== false;
    if ("neverSave" in s) {
      settings.neverSave = Array.isArray(s.neverSave)
        ? s.neverSave.filter((h) => typeof h === "string").map((h) => h.toLowerCase()).slice(0, 1000)
        : [];
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const s = {};
    for (const k of ["offerSave", "showIcon", "neverSave"]) if (changes[k]) s[k] = changes[k].newValue;
    applySettings(s);
    scan();
    if (bar && !settings.offerSave) closeBar(false);
  });

  // ---------- wiring ----------
  let scanTimer = 0, lastHref = location.href;
  function onUrlMaybeChanged() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    scheduleScan();
    schedulePending(800);
  }
  function scheduleScan() {
    if (scanTimer) return; // throttle: at most one scan per 250 ms even under constant mutations
    scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, 250);
  }
  const mo = new MutationObserver((muts) => {
    if (shadowHost && muts.every((m) => m.target === shadowHost ||
      (m.type === "childList" && [...m.addedNodes, ...m.removedNodes].every((n) => n === shadowHost)))) return;
    scheduleScan();
    onUrlMaybeChanged();
  });
  mo.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["type", "style", "class", "hidden", "disabled", "aria-hidden"],
  });

  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("focusin", () => { scheduleScan(); schedulePosition(); }, true);
  window.addEventListener("scroll", schedulePosition, { capture: true, passive: true });
  window.addEventListener("resize", schedulePosition, { passive: true });
  window.addEventListener("popstate", onUrlMaybeChanged);
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("navigatesuccess", onUrlMaybeChanged);
  }

  chrome.storage.local.get({ offerSave: true, showIcon: true, neverSave: [] }, (s) => {
    applySettings(s || {});
    scan();
    schedulePending(300);
  });
})();
