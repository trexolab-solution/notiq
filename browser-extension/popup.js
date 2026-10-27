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
