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
  extension_outdated: "This version of Notiq needs a newer Notiq Autofill extension. Update the extension, then try again.",
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
let extVersion = "";
try {
  const v = chrome.runtime.getManifest().version;
  if (typeof v === "string") { extVersion = v; document.getElementById("version").textContent = `Notiq Autofill v${v}`; }
} catch { /* no manifest (test stub) */ }
// Locked vault / version mismatch: a short status plus, when the user has to do something, a notice
// above the Fill button (text only). The background also drops any held multi-step password here
// when Notiq is locked or closed.
const notice = document.getElementById("notice");
function showNotice(text) { notice.textContent = text || ""; notice.hidden = !text; }
try {
  chrome.runtime.sendMessage({ type: "ping" }, (res) => {
    if (chrome.runtime.lastError || !res) { setStatus("off", "Notiq not running"); loadSite("off"); return; }
    const s = NS ? NS.appStatus(res, extVersion) : { state: res.ok ? "on" : "off", text: res.ok ? "Notiq running" : "Notiq not running", detail: "" };
    if (s.state === "off") setStatus("off", s.text, res.error === "no_host" ? TEXT.no_host : TEXT.app_not_running);
    // The header names the lock state: "Notiq unlocked" / "Notiq is locked".
    else setStatus(s.state, s.state === "on" ? "Notiq unlocked" : s.text, s.detail);
    if (s.state === "locked" || s.state === "update_app" || s.state === "update_ext") showNotice(s.detail);
    loadSite(s.state); // this site's logins (below)
  });
} catch { setStatus("off", "Notiq not running"); }
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
const DEFAULTS = { offerSave: true, showIcon: true, suggestOnFocus: false, neverSave: [], hiddenSites: [], reuseTrusted: [], theme: null };
const offerSave = document.getElementById("offerSave");
const showIcon = document.getElementById("showIcon");
const suggestOnFocus = document.getElementById("suggestOnFocus");
const suggestRow = document.getElementById("suggestRow");
// Per-site lists: × removes the site (the content scripts follow the storage change).
const SITE_LISTS = [
  { key: "neverSave", list: "neverList", count: "neverCount", undo: (h) => `Offer to save logins for ${h} again` },
  { key: "hiddenSites", list: "hiddenList", count: "hiddenCount", undo: (h) => `Show Notiq on ${h} again` },
  { key: "reuseTrusted", list: "trustedList", count: "trustedCount", undo: (h) => `Warn about passwords of other sites on ${h} again` },
];
function renderSites({ key, list: listId, count: countId, undo }, hosts) {
  const list = document.getElementById(listId);
  const count = document.getElementById(countId);
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
    rm.title = undo(host);
    rm.setAttribute("aria-label", `Remove ${host}`);
    rm.addEventListener("click", async () => {
      const cur = (await chrome.storage.local.get(DEFAULTS))[key];
      const next = (Array.isArray(cur) ? cur : []).filter((h) => h !== host);
      await chrome.storage.local.set({ [key]: next });
    });
    li.append(name, rm);
    list.appendChild(li);
  }
}
const hostsOf = (v) => (NS ? NS.hostList(v) : Array.isArray(v) ? v.filter((h) => typeof h === "string") : []);

// "Hide Notiq on this site" for the active tab (the background takes the host from the tab's URL).
const siteHideRow = document.getElementById("siteHideRow");
const siteHide = document.getElementById("siteHide");
const siteHideHost = document.getElementById("siteHideHost");
function loadSiteHidden() {
  try {
    chrome.runtime.sendMessage({ type: "siteHidden" }, (res) => {
      if (chrome.runtime.lastError || !res || res.ok !== true || typeof res.host !== "string") { siteHideRow.hidden = true; return; }
      siteHideHost.textContent = `${res.host.slice(0, 253)}: no icon; this button and Alt+Shift+L still work`;
      siteHide.checked = res.hidden === true;
      siteHideRow.hidden = false;
    });
  } catch { siteHideRow.hidden = true; }
}
siteHide.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "setSiteHidden", hidden: siteHide.checked }, (res) => {
    if (chrome.runtime.lastError || !res || res.ok !== true) loadSiteHidden();
  });
});
loadSiteHidden();

function render(s) {
  offerSave.checked = s.offerSave !== false;
  showIcon.checked = s.showIcon !== false;
  suggestOnFocus.checked = s.suggestOnFocus === true;
  // The suggestion is part of the in-field UI: it never shows while the icon is off.
  suggestOnFocus.disabled = !showIcon.checked;
  suggestRow.classList.toggle("off", !showIcon.checked);
  for (const l of SITE_LISTS) renderSites(l, l.key === "neverSave" && Array.isArray(s.neverSave) ? s.neverSave.filter((h) => typeof h === "string") : hostsOf(s[l.key]));
  if (!siteHideRow.hidden && siteHideHost.textContent) loadSiteHidden(); // the list may have changed this site
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

// ---------- this site's logins (0.9.0) ----------
// Titles + usernames of the logins that match the active tab's site, from the app (popupkit.js validates and
// filters). Row: fill (normal approval in Notiq) + copy username / password / 2FA code (Notiq copies it; the
// value never reaches the extension) + open in Notiq. Rendered with textContent only.
const NP = globalThis.NotiqPopup;
const site = document.getElementById("site");
const siteTitle = document.getElementById("siteTitle");
const siteCount = document.getElementById("siteCount");
const filter = document.getElementById("filter");
const accList = document.getElementById("accList");
const siteState = document.getElementById("siteState");
let accounts = [];
let lastState = "";

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  username: ["c:12,8,4", "M4 21c0-4 4-6 8-6s8 2 8 6"],
  password: ["c:7.5,15.5,4.5", "M10.7 12.3 20 3", "M16.5 6.5l3 3", "M14 9l2 2"],
  code: ["c:12,13,8", "M12 9v4l2.5 2", "M9 2h6"],
  open: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
};
const TIPS = { username: "Copy username", password: "Copy password", code: "Copy 2FA code", open: "Open in Notiq" };
function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2",
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const d of ICONS[name]) {
    let el;
    if (d.startsWith("c:")) {
      const [cx, cy, r] = d.slice(2).split(",");
      el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("cx", cx); el.setAttribute("cy", cy); el.setAttribute("r", r);
    } else {
      el = document.createElementNS(SVG_NS, "path");
      el.setAttribute("d", d);
    }
    svg.appendChild(el);
  }
  return svg;
}

function say(text, cls = "") { msg.className = cls; msg.textContent = text || ""; }
const actionError = (res) => (NP ? NP.actionText(res && res.error) : "Something went wrong.");

function siteMessage(text) { siteState.textContent = text || ""; }

function renderAccounts() {
  const shown = NP.filterAccounts(accounts, filter.value);
  accList.textContent = "";
  filter.hidden = !accounts.length;
  siteCount.textContent = accounts.length > 1 ? (shown.length === accounts.length ? `${accounts.length}` : `${shown.length} of ${accounts.length}`) : "";
  for (const a of shown) accList.appendChild(accountRow(a));
  if (!accounts.length) siteMessage(NP.listText("empty"));
  else if (!shown.length) siteMessage(`No logins match “${filter.value.trim().slice(0, 60)}”.`);
  else siteMessage("");
}

function accountRow(a) {
  const li = document.createElement("li");
  const text = NP.rowText(a);
  const names = NP.labels(a);
  const main = document.createElement("button");
  main.type = "button";
  main.className = "acc-main";
  main.setAttribute("aria-label", names.fill);
  main.title = "Fill on this page";
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = text.title;
  const u = document.createElement("span");
  u.className = "u";
  u.textContent = text.sub;
  main.append(t, u);
  main.addEventListener("click", () => fillAccount(a));
  li.appendChild(main);
  for (const what of ["username", "password", "code", "open"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ico";
    b.dataset.action = what;
    b.setAttribute("aria-label", names[what]);
    b.title = what === "code" && !a.totp ? "No 2FA code saved" : TIPS[what];
    b.appendChild(icon(what));
    if ((what === "code" && !a.totp) || (what === "username" && !a.username)) b.disabled = true;
    b.addEventListener("click", () => (what === "open" ? openAccount(a) : copyAccount(a, what, b)));
    li.appendChild(b);
  }
  return li;
}

// Something about the list changed in the app (a stale account): load it again.
function reloadSite() { if (lastState === "on") loadSite("on"); }

function fillAccount(a) {
  say("Waiting for your approval in Notiq…");
  chrome.runtime.sendMessage({ type: "popupFill", account: a.account }, (res) => {
    if (chrome.runtime.lastError) { say(TEXT.app_not_running, "err"); return; }
    if (res && res.ok) { say("Filled.", "ok"); setTimeout(() => window.close(), 700); return; }
    say(actionError(res), "err");
    if (res && res.error === "stale") reloadSite();
  });
}

function copyAccount(a, what, btn) {
  // A password or code copy may need your OK in Notiq (which can close this popup; the copy still happens).
  say(what === "username" ? "Copying…" : "Waiting for your approval in Notiq…");
  chrome.runtime.sendMessage({ type: "copy", account: a.account, what }, (res) => {
    if (chrome.runtime.lastError) { say(TEXT.app_not_running, "err"); return; }
    if (res && res.ok) {
      say(NP.copiedText(what, res.clearAfter), "ok");
      btn.classList.add("done");
      setTimeout(() => btn.classList.remove("done"), 1500);
      return;
    }
    say(actionError(res), "err");
    if (res && res.error === "stale") reloadSite();
  });
}

function openAccount(a) {
  say("Opening in Notiq…");
  chrome.runtime.sendMessage({ type: "open", account: a.account }, (res) => {
    if (chrome.runtime.lastError) { say(TEXT.app_not_running, "err"); return; }
    if (res && res.ok) { window.close(); return; }
    say(actionError(res), "err");
    if (res && res.error === "stale") reloadSite();
  });
}

// `state`: the header's appStatus state. Only an unlocked, compatible Notiq is asked for the list.
const STATE_ERROR = { off: "app_not_running", locked: "locked", update_app: "unknown_op", update_ext: "extension_outdated" };
function loadSite(state) {
  if (!NP) return;
  lastState = state;
  site.hidden = false;
  if (state !== "on") {
    accounts = [];
    renderAccounts();
    siteMessage(NP.listText(STATE_ERROR[state] || "app_not_running"));
    return;
  }
  siteMessage("Loading your logins for this site…");
  chrome.runtime.sendMessage({ type: "list" }, (res) => {
    if (chrome.runtime.lastError || !res) { accounts = []; renderAccounts(); siteMessage(NP.listText("app_not_running")); return; }
    if (typeof res.host === "string" && res.host) {
      siteTitle.textContent = `Logins for ${res.host.slice(0, 253)}`;
      siteTitle.title = res.host.slice(0, 253);
    }
    const list = res.ok ? NP.validAccounts(res.accounts) : null;
    accounts = list || [];
    renderAccounts();
    if (!list) { siteMessage(NP.listText(res.ok ? "malformed" : res.error)); return; }
    // Ready to type a filter (or press Enter to fill the first login).
    if (accounts.length && (document.activeElement === document.body || !document.activeElement)) filter.focus();
  });
}

filter.addEventListener("input", renderAccounts);
filter.addEventListener("keydown", (e) => {
  const first = accList.querySelector(".acc-main");
  if (e.key === "ArrowDown" && first) { e.preventDefault(); first.focus(); }
  else if (e.key === "Enter" && first) { e.preventDefault(); first.click(); }
});
accList.addEventListener("keydown", (e) => {
  const rows = [...accList.children];
  const li = document.activeElement && document.activeElement.closest ? document.activeElement.closest("li") : null;
  const at = rows.indexOf(li);
  if (at < 0) return;
  const cells = [...li.querySelectorAll("button")];
  const col = cells.indexOf(document.activeElement);
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const enabled = cells.filter((c) => !c.disabled);
    const k = enabled.indexOf(document.activeElement);
    const next = enabled[k + (e.key === "ArrowRight" ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); }
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const to = NP.nextRow(e.key, at, rows.length);
  if (to < 0) { if (!filter.hidden) filter.focus(); return; }
  const target = [...rows[to].querySelectorAll("button")];
  (target[col] && !target[col].disabled ? target[col] : target[0]).focus();
});
