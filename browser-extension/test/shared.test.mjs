// Unit tests for browser-extension/shared.js (theme validation, suggestion logic).
//   node --test browser-extension/test/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "shared.js"), "utf8");
const ctx = vm.createContext({});
vm.runInContext(src, ctx);
const NS = ctx.NotiqShared;

const GOOD = {
  id: "one-dark", mode: "dark", bg: "#282c34", bgSecondary: "#21252B", bgTertiary: "#3a3f4b", text: "#abb2bf",
  textMuted: "#5c6370", border: "#3e4451", primary: "#61afef", primaryText: "#0b0d10", danger: "#e06c75", success: "#98c379",
};
const plain = (o) => JSON.parse(JSON.stringify(o));

test("shared.js defines a frozen, non-writable NotiqShared", () => {
  assert.ok(NS && Object.isFrozen(NS));
  assert.equal(Reflect.set(ctx, "NotiqShared", null), false);
  assert.equal(ctx.NotiqShared, NS);
  vm.runInContext(src, ctx); // loading twice is harmless
  assert.equal(ctx.NotiqShared, NS);
});

test("validateTheme accepts a full theme and normalises colours", () => {
  const t = plain(NS.validateTheme(GOOD));
  assert.equal(t.bgSecondary, "#21252b");
  assert.deepEqual(Object.keys(t).sort(), ["id", "mode", ...NS.COLOR_KEYS].sort());
  assert.equal(plain(NS.validateTheme({ ...GOOD, mode: "light" })).mode, "light");
});

test("validateTheme drops unknown keys instead of copying them", () => {
  const t = NS.validateTheme({ ...GOOD, css: "body{display:none}", __proto__x: 1 });
  assert.ok(t);
  assert.equal("css" in t, false);
  assert.equal("__proto__x" in t, false);
});

test("validateTheme rejects bad input", () => {
  const bad = [
    null, undefined, "dark", 42, [], [GOOD],
    { ...GOOD, mode: "auto" }, { ...GOOD, mode: "Dark" }, { ...GOOD, mode: undefined },
    { ...GOOD, id: "" }, { ...GOOD, id: "x".repeat(65) }, { ...GOOD, id: "one dark" }, { ...GOOD, id: "a/b" },
    { ...GOOD, id: 7 }, { ...GOOD, id: "<script>" },
    { ...GOOD, bg: "#fff" }, { ...GOOD, bg: "#12345g" }, { ...GOOD, bg: "#1234567" }, { ...GOOD, bg: "red" },
    { ...GOOD, bg: "rgb(0,0,0)" }, { ...GOOD, bg: "#000000;background:url(x)" }, { ...GOOD, bg: " #000000" },
    { ...GOOD, bg: "#000000\n" }, { ...GOOD, primary: "var(--x)" }, { ...GOOD, text: 0x123456 }, { ...GOOD, success: null },
  ];
  for (const k of NS.COLOR_KEYS) { const t = { ...GOOD }; delete t[k]; bad.push(t); }
  const many = { ...GOOD };
  for (let i = 0; i < 40; i++) many[`k${i}`] = 1;
  bad.push(many);
  for (const b of bad) assert.equal(NS.validateTheme(b), null, JSON.stringify(b));
});

test("validateTheme ignores inherited properties", () => {
  const proto = { ...GOOD };
  assert.equal(NS.validateTheme(Object.create(proto)), null);
});

test("resolveTheme falls back to OS-matched defaults", () => {
  assert.equal(NS.resolveTheme(null, true).mode, "dark");
  assert.equal(NS.resolveTheme(null, false).mode, "light");
  assert.equal(NS.resolveTheme({ ...GOOD, bg: "nope" }, false).id, "notiq-light");
  assert.equal(NS.resolveTheme(GOOD, false).id, "one-dark");
  for (const t of Object.values(NS.DEFAULT_THEMES)) assert.ok(NS.validateTheme(t), t.id);
});

test("applyTheme sets one validated custom property at a time", () => {
  const props = [];
  const attrs = {};
  const elem = { style: { setProperty: (k, v) => props.push([k, v]) }, setAttribute: (k, v) => { attrs[k] = v; } };
  NS.applyTheme(elem, { ...GOOD, bg: "#000000;color:red" }, true); // invalid -> default dark
  assert.deepEqual(Object.fromEntries(props)["--nq-bg"], NS.DEFAULT_THEMES.dark.bg);
  props.length = 0;
  NS.applyTheme(elem, GOOD, true);
  const m = Object.fromEntries(props);
  assert.equal(m["--nq-bg"], "#282c34");
  assert.equal(m["--nq-on-primary"], "#0b0d10");
  assert.equal(m["color-scheme"], "dark");
  assert.equal(attrs["data-nq-mode"], "dark");
  for (const [k, v] of props) {
    if (k === "color-scheme") continue;
    assert.match(k, /^--nq-[a-z0-9-]+$/);
    assert.match(v, /^#[0-9a-f]{6}$/);
  }
  assert.equal(props.length, NS.COLOR_KEYS.length + 1);
});

test("themeReplyAction: set / clear / keep", () => {
  assert.deepEqual(plain(NS.themeReplyAction({ ok: true, theme: GOOD })), { action: "set", theme: plain(NS.validateTheme(GOOD)) });
  assert.deepEqual(plain(NS.themeReplyAction({ ok: true, theme: null })), { action: "clear" });
  assert.deepEqual(plain(NS.themeReplyAction({ error: "unknown_op" })), { action: "clear" }); // older app
  for (const e of ["no_host", "app_not_running", "timeout", "no_reply"]) {
    assert.deepEqual(plain(NS.themeReplyAction({ error: e })), { action: "keep" }, e);
  }
  for (const r of [null, undefined, "x", [], {}, { ok: true }, { ok: true, theme: { ...GOOD, mode: "x" } }, { ok: "true", theme: GOOD }, { error: 5 }]) {
    assert.deepEqual(plain(NS.themeReplyAction(r)), { action: "keep" }, JSON.stringify(r));
  }
});

test("sameTheme", () => {
  const a = NS.validateTheme(GOOD);
  assert.ok(NS.sameTheme(a, NS.validateTheme({ ...GOOD })));
  assert.ok(!NS.sameTheme(a, NS.validateTheme({ ...GOOD, bg: "#000000" })));
  assert.ok(NS.sameTheme(null, null));
  assert.ok(!NS.sameTheme(a, null));
});

const VP = { width: 1000, height: 800 };
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const base = () => ({ showIcon: true, suggestOnFocus: true, detected: true, dismissed: false, menuOpen: false, filling: false,
  typed: false, rect: rect(100, 100, 240, 36), viewport: VP });

test("shouldSuggest: shown for a detected, visible field", () => assert.equal(NS.shouldSuggest(base()), true));
test("shouldSuggest: each blocker hides it", () => {
  const cases = {
    showIcon: false, suggestOnFocus: false, detected: false, dismissed: true, menuOpen: true, filling: true, typed: true,
  };
  for (const [k, v] of Object.entries(cases)) assert.equal(NS.shouldSuggest({ ...base(), [k]: v }), false, k);
  assert.equal(NS.shouldSuggest({ ...base(), rect: rect(100, 100, 80, 36) }), false, "narrow");
  assert.equal(NS.shouldSuggest({ ...base(), rect: rect(100, 100, 240, 10) }), false, "tiny");
  assert.equal(NS.shouldSuggest({ ...base(), rect: rect(100, -100, 240, 36) }), false, "above viewport");
  assert.equal(NS.shouldSuggest({ ...base(), rect: rect(1200, 100, 240, 36) }), false, "right of viewport");
  assert.equal(NS.shouldSuggest({ ...base(), rect: null }), false);
  assert.equal(NS.shouldSuggest(null), false);
});

test("suggestPosition: below the field, left-aligned, width follows the field", () => {
  assert.deepEqual(plain(NS.suggestPosition(rect(100, 100, 240, 36), 40, VP)), { left: 100, top: 140, width: 240, placement: "below" });
  assert.equal(NS.suggestPosition(rect(100, 100, 150, 36), 40, VP).width, 200); // min width
  assert.equal(NS.suggestPosition(rect(100, 100, 600, 36), 40, VP).width, 320); // max width
});
test("suggestPosition: flips above near the bottom, clamps to the viewport", () => {
  const p = NS.suggestPosition(rect(100, 740, 240, 36), 40, VP);
  assert.equal(p.placement, "above");
  assert.equal(p.top, 740 - 4 - 40);
  assert.equal(NS.suggestPosition(rect(900, 100, 240, 36), 40, VP).left, 1000 - 240 - 8); // right edge
  assert.equal(NS.suggestPosition(rect(-50, 100, 240, 36), 40, VP).left, 8); // left edge
  const narrow = NS.suggestPosition(rect(0, 100, 240, 36), 40, { width: 180, height: 800 });
  assert.equal(narrow.width, 164);
  // No room above either: stays below.
  assert.equal(NS.suggestPosition(rect(100, 10, 240, 770), 40, VP).placement, "below");
});
test("suggestPosition: null when the field is off screen", () => {
  assert.equal(NS.suggestPosition(rect(100, 900, 240, 36), 40, VP), null);
  assert.equal(NS.suggestPosition(rect(-400, 100, 240, 36), 40, VP), null);
});
test("rectsOverlap", () => {
  assert.ok(NS.rectsOverlap(rect(0, 0, 10, 10), rect(5, 5, 10, 10)));
  assert.ok(!NS.rectsOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10)));
  assert.ok(!NS.rectsOverlap(null, rect(0, 0, 1, 1)));
});
