// Notiq Autofill popup — the "Save and use passkeys with Notiq (experimental)" switch (off by default).
// Turning it on asks for the optional host access the browser needs to register the passkey page scripts
// (the same sites the extension's content script already runs on). Turning it off gives that access back. The
// background registers the scripts only while BOTH the setting and the access are there, and re-checks when
// either changes, so it still works if the browser closes this popup while its permission prompt is open.
(() => {
  "use strict";
  const ORIGINS = ["https://*/*", "http://localhost/*"];
  const box = document.getElementById("passkeys");
  if (!box) return;
  const perms = chrome.permissions;
  Promise.all([
    chrome.storage.local.get({ passkeys: false }),
    perms ? perms.contains({ origins: ORIGINS }).catch(() => false) : Promise.resolve(false),
  ]).then(([s, granted]) => { box.checked = s.passkeys === true && granted === true; }, () => {});

  box.addEventListener("change", () => {
    if (box.checked) {
      // Requested straight from the click (the browser needs the user gesture), then the setting is stored.
      const asked = perms ? perms.request({ origins: ORIGINS }) : Promise.resolve(false);
      chrome.storage.local.set({ passkeys: true }).catch(() => {});
      asked.catch(() => false).then((ok) => {
        if (ok) return;
        box.checked = false;
        return chrome.storage.local.set({ passkeys: false });
      }).catch(() => {});
    } else {
      chrome.storage.local.set({ passkeys: false })
        .then(() => (perms ? perms.remove({ origins: ORIGINS }) : false))
        .catch(() => {});
    }
  });
})();
