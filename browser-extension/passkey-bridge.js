// Notiq Autofill — passkeys (experimental), the bridge. Runs in the extension's isolated world of every frame
// at document_start, only while the passkey setting is on (registered by background.js next to passkey-page.js).
//
// It accepts one narrow message shape from its own window only ({tag, dir:"req", id, kind, options} posted by
// passkey-page.js), requires a recent user gesture (so a page can't make Notiq ask on load), and hands the plain
// request data to the background. The background takes the origin from the frame's real URL, never from here.
// Every answer goes back to this same window; anything unexpected means "fallback" (use the browser's dialog).
(() => {
  "use strict";
  if (globalThis.__notiqPasskeyBridge) return;
  globalThis.__notiqPasskeyBridge = true;
  const TAG = "notiq-passkey";
  const MAX_MESSAGE = 32 * 1024;

  function size(v) {
    try { return JSON.stringify(v).length; } catch { return Infinity; }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || typeof d !== "object" || d.tag !== TAG || d.dir !== "req") return;
    if (typeof d.id !== "string" || !/^(create|get)-[A-Za-z0-9-]{1,64}$/.test(d.id)) return;
    const respond = (payload) => window.postMessage({ ...payload, tag: TAG, dir: "res", id: d.id }, location.origin);
    if ((d.kind !== "create" && d.kind !== "get") || !d.id.startsWith(`${d.kind}-`)
      || !d.options || typeof d.options !== "object" || size(d.options) > MAX_MESSAGE) {
      respond({ fallback: true });
      return;
    }
    // Only right after a real click or key press on this page (this world's view can't be faked by the page).
    const ua = navigator.userActivation;
    if (!ua || ua.isActive !== true) { respond({ fallback: true }); return; }
    let ancestors = null;
    try { if (location.ancestorOrigins) ancestors = [...location.ancestorOrigins]; } catch { ancestors = null; }
    try {
      chrome.runtime.sendMessage({ type: "passkey", kind: d.kind, options: d.options, ancestors }, (res) => {
        if (chrome.runtime.lastError || !res || typeof res !== "object") { respond({ fallback: true }); return; }
        if (res.ok === true && res.credential && typeof res.credential === "object") respond({ ok: true, credential: res.credential });
        else if (res.error === "excluded" && d.kind === "create") respond({ error: "excluded" });
        else respond({ fallback: true });
      });
    } catch {
      respond({ fallback: true }); // the extension was reloaded: this page's bridge is gone
    }
  });
})();
