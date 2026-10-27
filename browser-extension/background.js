// Notiq Autofill — service worker. Talks to the Notiq app through the native host.
const HOST = "com.trexolab.notiq";

function ask(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, msg, (res) => {
      if (chrome.runtime.lastError) resolve({ error: "no_host", detail: chrome.runtime.lastError.message });
      else resolve(res || { error: "no_reply" });
    });
  });
}

// Runs inside the page. `host` must equal the frame's own host, so credentials
// are never typed into a different site's iframe.
function fillPage(host, cred) {
  if (location.hostname.toLowerCase() !== host) return 0;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.disabled && !el.readOnly;
  };
  const set = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    el.focus();
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const all = [...document.querySelectorAll("input")].filter(visible);
  const pw = all.find((i) => i.type === "password");
  const textual = (i) => ["text", "email", "tel", ""].includes(i.type) || !i.type;
  let n = 0;
  const otp = all.find((i) => textual(i) && (i.autocomplete === "one-time-code" ||
    /otp|totp|2fa|mfa|verification|security.?code|one.?time/i.test(`${i.name} ${i.id} ${i.placeholder}`)));
  if (pw) {
    const form = pw.form || document;
    const candidates = [...form.querySelectorAll("input")].filter((i) => visible(i) && textual(i) && i !== otp);
    const before = candidates.filter((i) => pw.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING);
    const user = before.length ? before[before.length - 1] : null;
    if (user && cred.username) { set(user, cred.username); n++; }
    set(pw, cred.password); n++;
  } else if (!otp) {
    // Username-first flows: fill the only visible text/email field.
    const user = all.find((i) => textual(i) && /user|email|login|account/i.test(`${i.name} ${i.id} ${i.autocomplete} ${i.type}`)) || all.find(textual);
    if (user && cred.username) { set(user, cred.username); n++; }
  }
  if (otp && cred.code) { set(otp, cred.code); n++; }
  return n;
}

async function fillActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return { error: "no_tab" };
  let u;
  try { u = new URL(tab.url); } catch { return { error: "bad_url" }; }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return { error: "not_https" };
  const host = u.hostname.toLowerCase();
  const res = await ask({ op: "fill", host });
  if (res.error) return res;
  const out = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: fillPage,
    args: [host, { username: res.username, password: res.password, code: res.code }],
  });
  const filled = out.reduce((a, r) => a + (r.result || 0), 0);
  return filled ? { ok: true, host, title: res.title } : { error: "no_fields" };
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg && msg.type === "fill") { fillActiveTab().then(send); return true; }
  if (msg && msg.type === "ping") { ask({ op: "ping" }).then(send); return true; }
  return false;
});
