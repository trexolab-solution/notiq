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
const DEFAULTS = { offerSave: true, showIcon: true, neverSave: [] };
const offerSave = document.getElementById("offerSave");
const showIcon = document.getElementById("showIcon");
const list = document.getElementById("neverList");
const count = document.getElementById("neverCount");

function renderNever(hosts) {
  list.textContent = "";
  count.textContent = hosts.length ? `(${hosts.length})` : "";
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
  renderNever(Array.isArray(s.neverSave) ? s.neverSave.filter((h) => typeof h === "string") : []);
}

chrome.storage.local.get(DEFAULTS, render);
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") chrome.storage.local.get(DEFAULTS, render);
});
offerSave.addEventListener("change", () => chrome.storage.local.set({ offerSave: offerSave.checked }));
showIcon.addEventListener("change", () => chrome.storage.local.set({ showIcon: showIcon.checked }));
