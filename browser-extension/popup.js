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
};
btn.addEventListener("click", () => {
  btn.disabled = true; msg.className = ""; msg.textContent = "Waiting for your approval in Notiq…";
  chrome.runtime.sendMessage({ type: "fill" }, (res) => {
    btn.disabled = false;
    if (res && res.ok) { msg.className = "ok"; msg.textContent = "Filled."; setTimeout(() => window.close(), 700); return; }
    msg.className = "err";
    msg.textContent = TEXT[res && res.error] || "Something went wrong.";
  });
});

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
