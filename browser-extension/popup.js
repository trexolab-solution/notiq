const NS = globalThis.NotiqShared; // shared.js
const btn = document.getElementById("fill");
const msg = document.getElementById("msg");
const TEXT = {
  app_not_running: "Notiq isn't running. Open the app and try again.",
  no_host: "Notiq isn't set up for this browser yet. Start the Notiq app once, then restart the browser.",
  locked: "The vault is locked. Unlock it in Notiq, then try again.",
  denied: "You declined in Notiq.",
  no_match: "No saved login for this site in your vault.",
  timeout: "No answer from Notiq in time.",
  not_https: "Autofill only works on secure (https) pages.",
  no_fields: "Couldn't find a login form on this page.",
  stale: "That list of logins expired. Try again.",
};
const chooser = document.getElementById("choose");

// ---------- theme (the Notiq app's, cached by the background; else an OS-matched default) ----------
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
let cachedTheme = null;
const applyTheme = () => { if (NS) NS.applyTheme(document.documentElement, cachedTheme, darkScheme.matches); };
darkScheme.addEventListener("change", applyTheme);

// ---------- header: connection status + version ----------
const status = document.getElementById("status");
const statusText = document.getElementById("statusText");
function setStatus(state, text, title) {
  status.dataset.state = state;
  statusText.textContent = text;
  status.title = title || "";
}
try {
  chrome.runtime.sendMessage({ type: "ping" }, (res) => {
    if (chrome.runtime.lastError || !res) { setStatus("off", "Notiq not running"); return; }
    if (res.ok) setStatus("on", "Notiq running");
    else if (res.error === "no_host") setStatus("off", "Notiq not running", TEXT.no_host);
    else setStatus("off", "Notiq not running", TEXT.app_not_running);
  });
} catch { setStatus("off", "Notiq not running"); }
try {
  const v = chrome.runtime.getManifest().version;
  if (typeof v === "string") document.getElementById("version").textContent = `Notiq Autofill v${v}`;
} catch { /* no manifest (test stub) */ }
// The real shortcut (the user may have changed or removed it in the browser's shortcut settings).
const shortcut = document.getElementById("shortcut");
try {
  if (chrome.commands && typeof chrome.commands.getAll === "function") {
    chrome.commands.getAll((cmds) => {
      const c = Array.isArray(cmds) ? cmds.find((x) => x && x.name === "fill-login") : null;
      if (c && typeof c.shortcut === "string") shortcut.textContent = c.shortcut.slice(0, 32);
    });
  }
} catch { /* keep the default hint */ }

// Several logins match: the app sends titles and usernames only (no secrets).
// Validated strictly and rendered with textContent only.
function validChoices(list) {
  if (!Array.isArray(list) || !list.length || list.length > 20) return null;
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== "object" || typeof c.account !== "string" || typeof c.title !== "string" || typeof c.username !== "string") return null;
    if (!c.account || c.account.length > 256 || c.title.length > 200 || c.username.length > 512) return null;
    out.push({ account: c.account, title: c.title, username: c.username });
  }
  return out;
}
function hideChooser() { chooser.hidden = true; chooser.textContent = ""; }
function showChooser(list) {
  chooser.textContent = "";
  for (const c of list) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "choice";
    b.setAttribute("role", "option");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = c.title || c.username || "Login";
    const u = document.createElement("span");
    u.className = "u";
    u.textContent = c.title ? c.username || "no username" : "";
    b.append(t, u);
    b.addEventListener("click", () => fill(c.account));
    li.appendChild(b);
    chooser.appendChild(li);
  }
  chooser.hidden = false;
  const first = chooser.querySelector("button");
  if (first) first.focus();
}
chooser.addEventListener("keydown", (e) => {
  const items = [...chooser.querySelectorAll("button")];
  const at = items.indexOf(document.activeElement);
  const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
  if (next === undefined || !items.length) return;
  e.preventDefault();
  items[(next + items.length) % items.length].focus();
});

function fill(account) {
  btn.disabled = true; msg.className = ""; msg.textContent = "Waiting for your approval in Notiq…";
  hideChooser();
  chrome.runtime.sendMessage(account ? { type: "fill", account } : { type: "fill" }, (res) => {
    btn.disabled = false;
    if (res && res.ok) { msg.className = "ok"; msg.textContent = "Filled."; setTimeout(() => window.close(), 700); return; }
    const list = res && !account ? validChoices(res.choose) : null;
    if (list) { msg.className = ""; msg.textContent = "Several logins match. Pick one:"; showChooser(list); return; }
    msg.className = "err";
    msg.textContent = (res && Object.prototype.hasOwnProperty.call(TEXT, res.error) && TEXT[res.error]) || "Something went wrong.";
  });
}
btn.addEventListener("click", () => fill());

// ---------- settings (chrome.storage.local; content.js reacts to changes) ----------
const DEFAULTS = { offerSave: true, showIcon: true, suggestOnFocus: false, neverSave: [], theme: null };
const offerSave = document.getElementById("offerSave");
const showIcon = document.getElementById("showIcon");
const suggestOnFocus = document.getElementById("suggestOnFocus");
const suggestRow = document.getElementById("suggestRow");
const list = document.getElementById("neverList");
const count = document.getElementById("neverCount");

function renderNever(hosts) {
  list.textContent = "";
  count.textContent = hosts.length ? String(hosts.length) : "";
  if (!hosts.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sites yet.";
    list.appendChild(li);
    return;
  }
  for (const host of hosts) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = host;
    name.title = host;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "×";
    rm.title = `Offer to save logins for ${host} again`;
    rm.setAttribute("aria-label", `Remove ${host}`);
    rm.addEventListener("click", async () => {
      const { neverSave } = await chrome.storage.local.get(DEFAULTS);
      const next = (Array.isArray(neverSave) ? neverSave : []).filter((h) => h !== host);
      await chrome.storage.local.set({ neverSave: next });
    });
    li.append(name, rm);
    list.appendChild(li);
  }
}

function render(s) {
  offerSave.checked = s.offerSave !== false;
  showIcon.checked = s.showIcon !== false;
  suggestOnFocus.checked = s.suggestOnFocus === true;
  // The suggestion is part of the in-field UI: it never shows while the icon is off.
  suggestOnFocus.disabled = !showIcon.checked;
  suggestRow.classList.toggle("off", !showIcon.checked);
  renderNever(Array.isArray(s.neverSave) ? s.neverSave.filter((h) => typeof h === "string") : []);
  cachedTheme = NS ? NS.validateTheme(s.theme) : null;
  applyTheme();
}

applyTheme();
chrome.storage.local.get(DEFAULTS, render);
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") chrome.storage.local.get(DEFAULTS, render);
});
offerSave.addEventListener("change", () => chrome.storage.local.set({ offerSave: offerSave.checked }));
showIcon.addEventListener("change", () => chrome.storage.local.set({ showIcon: showIcon.checked }));
suggestOnFocus.addEventListener("change", () => chrome.storage.local.set({ suggestOnFocus: suggestOnFocus.checked }));
// Refresh the app's theme now (the background caches it; the change arrives via storage).
try { chrome.runtime.sendMessage({ type: "theme" }, () => void chrome.runtime.lastError); } catch { /* ignore */ }
