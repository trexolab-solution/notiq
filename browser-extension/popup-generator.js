// Notiq Autofill popup — the password generator view (generator.js has the pure part). Options are remembered in
// chrome.storage.local ("genOptions"); the generated password lives only in this popup's memory and is never stored.
// "Fill password" types it into the active tab's visible password fields (new + confirm) with a one-shot
// scripting.executeScript (activeTab), top frame only, so nothing needs to change in background.js / content.js.
(() => {
  "use strict";
  const G = globalThis.NotiqGen;
  const $ = (id) => document.getElementById(id);
  if (!G || !$("viewGen")) return;

  const KEY = "genOptions";
  const el = {
    value: $("genValue"), len: $("genLen"), lenVal: $("genLenVal"), strength: $("genStrength"), strengthText: $("genStrengthText"),
    fill: $("genFill"), msg: $("genMsg"), copy: $("genCopy"),
    flags: { upper: $("genUpper"), lower: $("genLower"), digits: $("genDigits"), symbols: $("genSymbols"), avoidAmbiguous: $("genAmbiguous") },
  };
  let opts = G.sanitize(null);
  let current = "";
  let msgTimer = 0;

  const say = (text, cls = "") => {
    clearTimeout(msgTimer);
    el.msg.className = "gen-msg " + cls;
    el.msg.textContent = text;
    if (text && cls === "ok") msgTimer = setTimeout(() => { el.msg.textContent = ""; }, 2500);
  };

  function readOptions() {
    return G.sanitize({ length: el.len.value, ...Object.fromEntries(Object.entries(el.flags).map(([k, c]) => [k, c.checked])) });
  }
  function showOptions() {
    el.len.value = String(opts.length);
    el.lenVal.textContent = String(opts.length);
    for (const [k, c] of Object.entries(el.flags)) c.checked = opts[k];
    // The last enabled class cannot be switched off.
    const on = ["upper", "lower", "digits", "symbols"].filter((k) => opts[k]);
    for (const k of ["upper", "lower", "digits", "symbols"]) el.flags[k].disabled = on.length === 1 && on[0] === k;
    const s = G.strength(opts);
    el.strength.dataset.level = String(s.level);
    el.strengthText.textContent = `${s.label} · ${s.bits} bits`;
  }
  function regenerate() {
    current = G.generate(opts);
    el.value.textContent = current;
    say("");
  }
  function save() {
    try { chrome.storage.local.set({ [KEY]: opts }).catch(() => {}); } catch { /* options just aren't remembered */ }
  }
  function onChange() {
    opts = readOptions();
    showOptions();
    regenerate();
    save();
  }

  el.len.addEventListener("input", onChange);
  for (const c of Object.values(el.flags)) c.addEventListener("change", onChange);
  $("genRegen").addEventListener("click", () => { regenerate(); });

  // Copy. The extension has no clipboard permission, so there is no timed clear (the Notiq app does that for
  // its own copies); this is a plain copy from the click.
  el.copy.addEventListener("click", async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current);
      say("Copied. Clear your clipboard when you're done.", "ok");
    } catch {
      say("Couldn't copy. Select the password and copy it yourself.", "err");
    }
  });

  // ---------- Fill password (active tab, top frame) ----------
  // Self-contained (executeScript serializes it, no closures): value === null only counts the fields, otherwise
  // it types the value into them. With 3+ fields (current / new / confirm) only the "new" ones are filled.
  function pageFill(value) {
    const FK = globalThis.NotiqFill;
    const all = FK && typeof FK.deepQuery === "function" ? FK.deepQuery(document, "input") : [...document.querySelectorAll("input")];
    const ok = (i) => {
      if (i.type !== "password" || i.disabled || i.readOnly) return false;
      const r = i.getBoundingClientRect();
      const cs = getComputedStyle(i);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const shown = all.filter(ok);
    if (!shown.length) return 0;
    const active = shown.find((i) => i === document.activeElement);
    const form = (active || shown[0]).form;
    let group = form ? shown.filter((i) => i.form === form) : shown.filter((i) => !i.form);
    if (!group.length) group = shown;
    const fresh = group.filter((i) => /new-password/i.test(i.getAttribute("autocomplete") || ""));
    const fields = fresh.length ? fresh : group.length >= 3 ? group.slice(1) : group;
    if (typeof value !== "string") return fields.length;
    for (const f of fields) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f), "value")?.set;
      f.focus();
      if (setter) setter.call(f, value); else f.value = value;
      f.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      f.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return fields.length;
  }
  const inject = (value) => chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: pageFill, args: [value] });
  let tabId = -1;

  async function checkFillable() {
    el.fill.hidden = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || typeof tab.id !== "number" || !/^https:|^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(tab.url || "")) return;
      tabId = tab.id;
      const [r] = await inject(null);
      el.fill.hidden = !(r && r.result > 0);
    } catch { /* no access to this page: no button */ }
  }
  el.fill.addEventListener("click", async () => {
    if (!current) return;
    el.fill.disabled = true;
    try {
      const [r] = await inject(current);
      const n = r && r.result;
      if (n > 0) say(n > 1 ? `Filled ${n} password fields.` : "Filled.", "ok");
      else say("No password field found on this page.", "err");
    } catch {
      say("Couldn't fill this page.", "err");
    }
    el.fill.disabled = false;
  });

  // Entering the view: fresh password, check the page again.
  let shown = false;
  new MutationObserver(() => {
    const open = !$("viewGen").hidden;
    if (open && !shown) { regenerate(); checkFillable(); }
    shown = open;
  }).observe($("viewGen"), { attributes: true, attributeFilter: ["hidden"] });

  // Remembered options first, then the first password.
  const start = (stored) => { opts = G.sanitize(stored); showOptions(); regenerate(); };
  try {
    chrome.storage.local.get({ [KEY]: null }).then((s) => start(s[KEY]), () => start(null));
  } catch { start(null); }
})();
