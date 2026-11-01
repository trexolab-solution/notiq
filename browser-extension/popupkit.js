// Notiq Autofill — pure helpers for the toolbar popup's site logins list (0.9.0). Loaded by popup.html
// before popup.js; unit-tested in test/popupkit.test.mjs. No DOM, no chrome.* here.
//
// The list holds titles and usernames of the logins that match the CURRENT tab's site only (the app never
// sends the whole vault, and never a secret). Copies are done by the Notiq app itself; the popup only hears
// "copied" back, so no password or code ever passes through the extension.
(function (g) {
  "use strict";
  if (g.NotiqPopup) return;

  const MAX = { accounts: 50, account: 256, title: 200, username: 512, query: 200 };
  const COPY_WHAT = Object.freeze(["username", "password", "code"]);
  const clean = (s, max) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

  // The background's (already re-validated) list: [{ account, title, username, totp }], or null when malformed.
  function validAccounts(list) {
    if (!Array.isArray(list) || list.length > MAX.accounts) return null;
    const out = [];
    const seen = new Set();
    for (const a of list) {
      if (!a || typeof a !== "object" || Array.isArray(a)) return null;
      if (typeof a.account !== "string" || typeof a.title !== "string" || typeof a.username !== "string") return null;
      if (!a.account || a.account.length > MAX.account || a.title.length > MAX.title || a.username.length > MAX.username) return null;
      if (seen.has(a.account)) continue;
      seen.add(a.account);
      out.push({ account: a.account, title: clean(a.title, MAX.title), username: clean(a.username, MAX.username), totp: a.totp === true });
    }
    return out;
  }

  // Case-insensitive filter over title + username; every space-separated word must match.
  function filterAccounts(list, query) {
    const words = (typeof query === "string" ? query.slice(0, MAX.query) : "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return list.slice();
    return list.filter((a) => {
      const hay = `${a.title} ${a.username}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  // What a row shows: the title (else the username, else "Login") and, under it, the username.
  function rowText(a) {
    const title = a.title || a.username || "Login";
    return { title, sub: a.title ? a.username || "no username" : "" };
  }

  const WHAT_TITLE = Object.freeze({ username: "Username", password: "Password", code: "2FA code" });

  // Accessible names for a row's controls.
  function labels(a) {
    const name = rowText(a).title;
    const who = a.title && a.username ? `${name} (${a.username})` : name;
    return {
      fill: `Fill ${who}`,
      username: `Copy username of ${name}`,
      password: `Copy password of ${name}`,
      code: a.totp ? `Copy 2FA code of ${name}` : `No 2FA code saved for ${name}`,
      open: `Open ${name} in Notiq`,
    };
  }

  function formatDelay(s) {
    return s < 60 ? `${s} s` : s % 60 === 0 ? `${s / 60} min` : `${Math.round(s / 6) / 10} min`;
  }

  // Message after a copy the app confirmed. `clearAfter`: seconds (0 = never).
  function copiedText(what, clearAfter) {
    const t = WHAT_TITLE[what] || "Value";
    const s = Number.isInteger(clearAfter) && clearAfter > 0 && clearAfter <= 3600 ? clearAfter : 0;
    return s ? `${t} copied by Notiq. Clears in ${formatDelay(s)}.` : `${t} copied by Notiq.`;
  }

  // The site list's state line, from the background's { error } (or an empty list).
  const LIST_TEXT = Object.freeze({
    empty: "No saved logins for this site.",
    locked: "Unlock Notiq to see your logins for this site.",
    app_not_running: "Open Notiq to see your logins for this site.",
    no_host: "Open Notiq to see your logins for this site.",
    unknown_op: "Update Notiq to see your logins for this site here.",
    extension_outdated: "Update the extension to see your logins for this site.",
    not_https: "Logins are listed on secure (https) pages only.",
    bad_url: "Logins are listed on web pages only.",
    no_tab: "Logins are listed on web pages only.",
  });
  function listText(error) {
    return Object.prototype.hasOwnProperty.call(LIST_TEXT, error) ? LIST_TEXT[error] : "Couldn't load your logins for this site.";
  }

  // Errors of a row action (fill, copy, open).
  const ACTION_TEXT = Object.freeze({
    unknown_op: "Update Notiq to use this.",
    app_not_running: "Notiq isn't running. Open the app and try again.",
    no_host: "Notiq isn't running. Open the app and try again.",
    locked: "The vault is locked. Unlock it in Notiq, then try again.",
    denied: "You declined in Notiq.",
    timeout: "No answer from Notiq in time.",
    stale: "That login is no longer saved for this site. The list was refreshed.",
    no_code: "No 2FA code saved for this login.",
    empty: "Nothing saved to copy.",
    no_fields: "Couldn't find a login form on this page.",
    not_https: "Autofill only works on secure (https) pages.",
    extension_outdated: "This version of Notiq needs a newer Notiq Autofill extension.",
    busy: "Notiq is busy with another request.",
  });
  function actionText(error) {
    return Object.prototype.hasOwnProperty.call(ACTION_TEXT, error) ? ACTION_TEXT[error] : "Something went wrong.";
  }

  // Arrow-key movement in a list of `n` rows: the next row index, or -1 to go back to the filter box.
  function nextRow(key, at, n) {
    if (!n) return -1;
    switch (key) {
      case "ArrowDown": return at < 0 ? 0 : Math.min(at + 1, n - 1);
      case "ArrowUp": return at <= 0 ? -1 : at - 1;
      case "Home": return 0;
      case "End": return n - 1;
      default: return at;
    }
  }

  // One letter for a row's avatar (drawn by CSS from a data attribute; never markup).
  function initial(a) {
    const name = a ? rowText(a).title : "";
    const m = /[\p{L}\p{N}]/u.exec(name);
    return m ? m[0].toLocaleUpperCase() : "?";
  }

  // The header's short connection line, from shared.js appStatus().state (+ whether the host is missing).
  const STATUS_LABEL = Object.freeze({
    unknown: "Checking Notiq…",
    on: "Unlocked",
    locked: "Vault locked",
    off: "Notiq not running",
    update_app: "Update Notiq",
    update_ext: "Update the extension",
  });
  function statusLabel(state, noHost) {
    if (state === "off" && noHost) return "Notiq not set up";
    return Object.prototype.hasOwnProperty.call(STATUS_LABEL, state) ? STATUS_LABEL[state] : STATUS_LABEL.off;
  }

  // What the main view shows instead of the site's logins, or null when the logins can be shown.
  // conn: appStatus state ("unknown" while checking); pageError: the active tab's error (not_https / bad_url
  // mean nothing can be filled here; anything else is ignored); detail: appStatus detail for the update states.
  // action: "retry" asks Notiq again (the same ping); "" has no button.
  function mainPanel({ conn, pageError, noHost, detail } = {}) {
    if (pageError === "not_https") return { icon: "page", title: "Notiq can't fill this page",
      text: "Logins are filled and saved on secure (https) websites only.", action: "" };
    if (pageError === "bad_url") return { icon: "page", title: "Nothing to fill here",
      text: "Open a website to see and fill its logins.", action: "" };
    const d = typeof detail === "string" ? detail.slice(0, 400) : "";
    switch (conn) {
      case "on": case "unknown": case undefined: return null;
      case "locked": return { icon: "lock", title: "Your vault is locked",
        text: "Unlock it in the Notiq app to see and fill your logins for this site.", action: "retry", actionLabel: "Check again" };
      case "update_app": return { icon: "update", title: "Update Notiq", text: d || "This extension needs a newer Notiq app.", action: "" };
      case "update_ext": return { icon: "update", title: "Update the extension", text: d || "This Notiq app needs a newer Notiq Autofill extension.", action: "" };
      default: return noHost
        ? { icon: "power", title: "Notiq isn't set up for this browser", text: "Start the Notiq app once, then restart the browser.", action: "retry", actionLabel: "Try again" }
        : { icon: "power", title: "Notiq isn't running", text: "Open the Notiq app on this computer, then try again.", action: "retry", actionLabel: "Try again" };
    }
  }

  const api = Object.freeze({ MAX, COPY_WHAT, validAccounts, filterAccounts, rowText, labels, copiedText, listText, actionText, nextRow,
    initial, statusLabel, mainPanel });
  try {
    Object.defineProperty(g, "NotiqPopup", { value: api, writable: false, configurable: false, enumerable: false });
  } catch { /* already defined */ }
})(typeof globalThis !== "undefined" ? globalThis : self);
