// Static checks of the toolbar popup's page (popup.html): the DOM contract its scripts rely on, the bottom tab
// bar's ARIA structure, and the accessibility / store rules of the mobile layout. Behaviour in a real browser
// (tab switching, arrow keys, Esc, every state) is covered by test/e2e-cdp.mjs.
//   node --test browser-extension/test/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(dir, "popup.html"), "utf8");
const CSS = (HTML.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];
const SCRIPTS = ["popup.js", "popup-generator.js", "popup-passkeys.js"].map((f) => [f, readFileSync(join(dir, f), "utf8")]);
const kitCtx = vm.createContext({});
vm.runInContext(readFileSync(join(dir, "popupkit.js"), "utf8"), kitCtx);
const NP = kitCtx.NotiqPopup;

// Start tags with their attributes (enough for this hand-written page).
const TAGS = [...HTML.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)].map(([, tag, rest]) => {
  const attrs = {};
  for (const [, k, v] of rest.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) attrs[k] = v === undefined ? "" : v;
  return { tag, attrs };
});
const byId = (id) => TAGS.filter((t) => t.attrs.id === id);
const one = (id) => { const t = byId(id); assert.equal(t.length, 1, `#${id} once`); return t[0]; };

test("popup.html: ids are unique and every id the popup scripts look up exists", () => {
  const ids = TAGS.map((t) => t.attrs.id).filter(Boolean);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "duplicate ids");
  for (const [file, src] of SCRIPTS) {
    const used = [...src.matchAll(/(?:\$|getElementById)\("([A-Za-z][\w-]*)"\)/g)].map((m) => m[1]);
    assert.ok(used.length > 0 || file === "popup-passkeys.js", file);
    for (const id of used) assert.equal(byId(id).length, 1, `${file} uses #${id}`);
  }
  // The ids the e2e tests and the README rely on.
  for (const id of ["fill", "msg", "choose", "status", "statusText", "version", "siteHost", "siteChip", "siteMenuBtn", "siteMenu", "siteHide",
    "panel", "accList", "filter", "siteState", "siteEmpty", "showIcon", "suggestOnFocus", "offerSave", "passkeys", "neverList", "hiddenList",
    "trustedList", "genValue", "genFill", "genLen", "openGen", "openSettings"]) one(id);
});

test("popup.html: the bottom tab bar is a tablist with one selected tab (roving tabindex)", () => {
  const list = one("tabbar");
  assert.equal(list.attrs.role, "tablist");
  assert.ok(list.attrs["aria-label"]);
  const tabs = TAGS.filter((t) => t.attrs.role === "tab");
  assert.deepEqual(tabs.map((t) => t.attrs["data-tab"]), [...NP.TABS]);
  assert.deepEqual(tabs.map((t) => t.attrs.id), ["tabLogins", "openGen", "openSettings"]);
  assert.deepEqual(tabs.map((t) => t.attrs["aria-selected"]), ["true", "false", "false"]);
  assert.deepEqual(tabs.map((t) => t.attrs.tabindex), ["0", "-1", "-1"]);
  for (const t of tabs) {
    assert.equal(t.tag, "button");
    assert.equal(t.attrs.type, "button");
    const panel = one(t.attrs["aria-controls"]);
    assert.equal(panel.attrs.role, "tabpanel");
    assert.equal(panel.attrs["aria-labelledby"], t.attrs.id);
  }
  // Only the Logins panel shows at first.
  assert.equal("hidden" in one("viewMain").attrs, false);
  for (const id of ["viewGen", "viewSettings", "viewNever", "viewHidden", "viewTrusted"]) assert.ok("hidden" in one(id).attrs, id);
});

test("popup.html: settings' site lists are slide-in screens with a back button and a focusable heading", () => {
  for (const [view, title] of [["viewNever", "neverTitle"], ["viewHidden", "hiddenTitle"], ["viewTrusted", "trustedTitle"]]) {
    const at = HTML.indexOf(`id="${view}"`);
    const end = HTML.indexOf("</ul>", at);
    const block = HTML.slice(at, end);
    assert.match(block, /data-back="settings" aria-label="Back to settings"/, view);
    assert.match(block, new RegExp(`<h1 id="${title}" tabindex="-1">`), view);
    assert.equal(NP.tabOf(view.slice(4).toLowerCase()), "settings");
  }
  for (const id of ["genTitle", "settingsTitle", "mainTitle"]) assert.equal(one(id).attrs.tabindex, "-1", id);
  // The rows that open them.
  for (const v of ["never", "hidden", "trusted"]) assert.equal(TAGS.filter((t) => t.attrs["data-view"] === v).length, 1, v);
});

test("popup.html: controls keep their accessible names and descriptions", () => {
  assert.equal(one("fill").attrs["aria-describedby"], "help");
  one("help");
  assert.equal(one("siteMenuBtn").attrs["aria-haspopup"], "true");
  assert.equal(one("siteMenuBtn").attrs["aria-controls"], "siteMenu");
  assert.ok(one("siteMenuBtn").attrs["aria-label"]);
  assert.ok(one("filter").attrs["aria-label"]);
  assert.equal(one("genValue").attrs["aria-label"], "Generated password");
  for (const id of ["msg", "genMsg", "siteState"]) assert.equal(one(id).attrs["aria-live"], "polite", id);
  // Every switch is a real checkbox with role=switch, inside a label (its name).
  const switches = TAGS.filter((t) => t.attrs.role === "switch");
  assert.ok(switches.length >= 10);
  for (const s of switches) assert.equal(s.attrs.type, "checkbox", s.attrs.id);
  // Icon-only buttons have a name.
  for (const t of TAGS.filter((x) => x.tag === "button" && x.attrs.class && /\bicon-btn\b/.test(x.attrs.class))) assert.ok(t.attrs["aria-label"], JSON.stringify(t.attrs));
});

test("popup.html: mobile layout rules (360px, 13px minimum text, focus rings, reduced motion)", () => {
  assert.match(CSS, /body \{ width: 360px;/);
  assert.match(CSS, /\.app \{[^}]*min-height: 420px; max-height: 600px;/);
  const sizes = [...CSS.matchAll(/font(?:-size)?:\s*(?:[0-9]{3}\s+)?([0-9.]+)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 20);
  assert.deepEqual(sizes.filter((n) => n < 13), [], "font sizes below 13px");
  assert.match(CSS, /:focus-visible \{ outline: 2px solid var\(--ring\)/);
  const reduced = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /animation: none !important/);
  assert.match(reduced, /transition: none !important/);
  // Both colour schemes: the OS default and the app's theme mode.
  assert.match(CSS, /@media \(prefers-color-scheme: light\)/);
  assert.match(CSS, /:root\[data-nq-mode="light"\]/);
});

test("popup.html: no remote resources (store / CSP rules)", () => {
  assert.doesNotMatch(HTML, /https?:\/\//);
  assert.doesNotMatch(HTML, /<link\b|@import|@font-face|url\(/);
  assert.doesNotMatch(HTML, /\son[a-z]+="/); // no inline handlers
  const scripts = [...HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /^ src="[a-z-]+\.js"$/);
    assert.equal(body, "");
  }
});
