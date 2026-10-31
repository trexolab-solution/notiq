// Unit tests for browser-extension/fillkit.js (site-aware password generator,
// open shadow root traversal).   node --test browser-extension/test/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fillkit.js"), "utf8");
const ctx = vm.createContext({ crypto: webcrypto, Uint32Array });
vm.runInContext(src, ctx);
const FK = ctx.NotiqFill;
const plain = (o) => JSON.parse(JSON.stringify(o));
const LOOKALIKE = /[Il1O0o]/;
const many = (c, n = 40) => Array.from({ length: n }, () => FK.generateFor(c));

test("fillkit.js defines a frozen NotiqFill", () => {
  assert.ok(FK && Object.isFrozen(FK));
  vm.runInContext(src, ctx);
  assert.equal(ctx.NotiqFill, FK);
});

test("no constraints: 20 characters, all four classes, no look-alikes", () => {
  for (const r of many({})) {
    assert.equal(r.password.length, 20);
    assert.equal(r.fallback, false);
    assert.equal(r.limited, false);
    assert.match(r.password, /[A-Z]/); assert.match(r.password, /[a-z]/);
    assert.match(r.password, /[0-9]/); assert.match(r.password, /[^A-Za-z0-9]/);
    assert.doesNotMatch(r.password, LOOKALIKE);
  }
  assert.equal(new Set(many({}, 20).map((r) => r.password)).size, 20);
});

test("maxlength below 20 is respected (never truncated), above 20 keeps 20", () => {
  for (const r of many({ maxLength: 16 })) { assert.equal(r.password.length, 16); assert.equal(r.limited, true); }
  for (const r of many({ maxLength: 64 })) assert.equal(r.password.length, 20);
  // -1 is what the DOM reports for "no maxlength"
  assert.equal(FK.generateFor({ maxLength: -1 }).password.length, 20);
});

test("a site maximum below the 12-character floor wins; the floor applies otherwise", () => {
  for (const r of many({ maxLength: 8 })) {
    assert.equal(r.password.length, 8);
    assert.match(r.password, /[A-Z]/); assert.match(r.password, /\d/); assert.match(r.password, /[^A-Za-z0-9]/);
  }
  assert.equal(FK.generateFor({ maxLength: 12 }).password.length, 12);
  assert.equal(FK.planPassword({}, { length: 8 }).length, 12, "floor of 12 when the site allows it");
  // A 3-character field cannot hold one of each of our 4 classes: we require fewer instead of failing.
  const r = FK.generateFor({ maxLength: 3 });
  assert.equal(r.password.length, 3);
  assert.equal(r.fallback, false);
});

test("minlength above 20 makes it longer", () => {
  assert.equal(FK.generateFor({ minLength: 32 }).password.length, 32);
  assert.equal(FK.generateFor({ minLength: 24, maxLength: 30 }).password.length, 24);
});

test("parsePasswordRules reads every rule", () => {
  const r = plain(FK.parsePasswordRules("minlength: 10; maxlength: 18; required: lower; required: upper; required: digit, [-_]; allowed: [!@]; max-consecutive: 2"));
  assert.equal(r.minlength, 10);
  assert.equal(r.maxlength, 18);
  assert.equal(r.maxConsecutive, 2);
  assert.equal(r.required.length, 3);
  assert.ok(r.required[2].includes("-") && r.required[2].includes("_") && r.required[2].includes("7"));
  assert.ok(r.allowed.includes("!") && r.allowed.includes("@"));
  assert.deepEqual(plain(FK.parsePasswordRules("")), { required: [], allowed: null, minlength: 0, maxlength: 0, maxConsecutive: 0 });
  assert.deepEqual(plain(FK.parsePasswordRules("nonsense; foo: bar")).required, []);
});

test("passwordrules: only allowed characters, every required class, length limits", () => {
  const rules = "minlength: 8; maxlength: 14; required: lower; required: upper; required: digit; allowed: [-_.]";
  for (const r of many({ rules })) {
    const p = r.password;
    assert.equal(p.length, 14);
    assert.match(p, /^[A-Za-z0-9._-]+$/, p);
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /\d/);
    assert.equal(r.fallback, false);
  }
});

test("passwordrules allowed without special: no symbols at all", () => {
  for (const r of many({ rules: "allowed: upper, lower, digit" })) {
    assert.match(r.password, /^[A-Za-z0-9]{20}$/);
    assert.match(r.password, /[A-Z]/); assert.match(r.password, /[a-z]/); assert.match(r.password, /\d/);
  }
});

test("passwordrules digits only (PIN-like) and max-consecutive", () => {
  for (const r of many({ rules: "required: digit; maxlength: 6; max-consecutive: 1" })) {
    assert.match(r.password, /^\d{6}$/);
    assert.ok(!/(.)\1/.test(r.password), r.password);
  }
});

test("maxlength attribute and passwordrules combine: the smaller maximum wins", () => {
  assert.equal(FK.generateFor({ maxLength: 10, rules: "maxlength: 16" }).password.length, 10);
  assert.equal(FK.generateFor({ maxLength: 30, rules: "maxlength: 16" }).password.length, 16);
});

test("simple pattern: character class and range", () => {
  assert.deepEqual(plain(FK.simplePattern("[A-Za-z0-9]{8,16}")).maxlength, 16);
  assert.equal(FK.simplePattern("(?=.*\\d).{8,}"), null);
  for (const r of many({ pattern: "[A-Za-z0-9]{8,16}" })) assert.match(r.password, /^[A-Za-z0-9]{16}$/);
  for (const r of many({ pattern: ".{8,64}" })) assert.equal(r.password.length, 20);
  for (const r of many({ pattern: "\\w{10,}" })) assert.match(r.password, /^\w{20}$/);
});

test("complex pattern is still checked against the result", () => {
  // Must start with a letter: some draws are thrown away, the result always matches.
  for (const r of many({ pattern: "[A-Za-z].{11,19}" })) assert.match(r.password, /^[A-Za-z].{11,19}$/);
});

test("impossible constraints fall back to the default password with a reason", () => {
  // Still never longer than the site's maximum (the site would cut it).
  const capped = FK.generateFor({ minLength: 30, maxLength: 10 });
  assert.equal(capped.fallback, true);
  assert.equal(capped.password.length, 10);
  assert.match(capped.password, /[A-Z]/); assert.match(capped.password, /[^A-Za-z0-9]/);
  const cases = [
    [{ rules: "required: [é]" }, 20],                     // no printable-ASCII characters left
    [{ rules: "required: upper; allowed: digit", pattern: "[0-9]{6}" }, 6], // required class not allowed by the pattern
    [{ minLength: 500 }, 20],
  ];
  for (const [c, len] of cases) {
    const r = FK.generateFor(c);
    assert.equal(r.fallback, true, JSON.stringify(c));
    assert.ok(r.reason, JSON.stringify(c));
    assert.equal(r.password.length, len, JSON.stringify(c));
  }
  const short = FK.generateFor({ rules: "required: lower; required: upper; required: digit; maxlength: 2" });
  assert.equal(short.fallback, true);
  assert.equal(short.password.length, 2);
});

test("deterministic draw with an injected random source", () => {
  let i = 0;
  const seq = (n) => (i++ * 7) % n;
  const plan = FK.planPassword({ maxLength: 12 });
  const p = FK.drawPassword(plan, seq);
  assert.equal(p.length, 12);
});

test("mergeConstraints: smallest max, largest min, first rules/pattern", () => {
  assert.deepEqual(plain(FK.mergeConstraints([
    { maxLength: -1, minLength: 0, rules: "", pattern: "" },
    { maxLength: 16, minLength: 8, rules: "required: digit", pattern: "" },
    { maxLength: 24, minLength: 10, rules: "required: upper", pattern: "\\S+" },
  ])), { maxLength: 16, minLength: 10, rules: "required: digit", pattern: "\\S+" });
});

// ---------- shadow traversal on a tiny fake DOM ----------
function node(tag, attrs = {}, kids = [], shadowKids = null) {
  const n = { tag, ...attrs, kids, parentNode: null, parentElement: null, shadowRoot: null };
  for (const k of kids) { k.parentNode = n; k.parentElement = n; }
  if (shadowKids) {
    const sr = { kids: shadowKids, host: n, querySelectorAll: () => descendants(sr), activeElement: null };
    for (const k of shadowKids) { k.parentNode = sr; k.parentElement = null; }
    n.shadowRoot = sr;
  }
  n.matches = (sel) => sel.split(",").map((s) => s.trim()).includes(n.tag);
  n.querySelectorAll = () => descendants(n);
  return n;
}
function descendants(n) {
  const out = [];
  const walk = (x) => { for (const k of x.kids) { out.push(k); walk(k); } };
  walk(n);
  return out;
}

test("deepQuery finds inputs inside open shadow roots, in tree order, recursively", () => {
  const a = node("input", { id: "a" });
  const b = node("input", { id: "b" });
  const c = node("input", { id: "c" });
  const d = node("input", { id: "d" });
  const inner = node("x-inner", {}, [], [c]);
  const host = node("x-login", {}, [], [b, node("div", {}, [inner])]);
  const doc = node("doc", {}, [a, host, d]);
  assert.deepEqual(FK.deepQuery(doc, "input").map((n) => n.id).join(), ["a", "b", "c", "d"].join());
  // A scope that is itself a shadow host includes its own shadow tree.
  assert.deepEqual(FK.deepQuery(host, "input").map((n) => n.id).join(), "b,c");
  // Closed roots look like no shadow root at all (shadowRoot === null): nothing inside is found.
  host.shadowRoot = null;
  assert.deepEqual(FK.deepQuery(doc, "input").map((n) => n.id).join(), ["a", "d"].join());
});

test("deepQuery is bounded in depth and number of roots, and skips our own host", () => {
  let leaf = node("input", { id: "deep" });
  for (let i = 0; i < 10; i++) leaf = node("x-wrap", {}, [], [leaf]);
  const doc = node("doc", {}, [leaf]);
  assert.equal(FK.deepQuery(doc, "input").length, 0, "10 levels > maxDepth 6");
  assert.equal(FK.deepQuery(doc, "input", { maxDepth: 12 }).length, 1);
  const hosts = Array.from({ length: 5 }, (_, i) => node("x-h", {}, [], [node("input", { id: `i${i}` })]));
  const doc2 = node("doc", {}, hosts);
  assert.equal(FK.deepQuery(doc2, "input", { maxRoots: 3 }).length, 3);
  assert.equal(FK.deepQuery(doc2, "input", { skip: (h) => h === hosts[0] }).length, 4);
  assert.equal(FK.shadowRoots(doc2).length, 5);
  assert.equal(FK.shadowRoots(doc2, { maxRoots: 2 }).length, 2);
});

test("deepActive and parentAcross step through shadow roots", () => {
  const inp = node("input", { id: "pw" });
  const host = node("x-login", {}, [], [inp]);
  const doc = node("doc", {}, [host]);
  doc.activeElement = host;
  host.shadowRoot.activeElement = inp;
  assert.equal(FK.deepActive(doc), inp);
  assert.equal(FK.parentAcross(inp), host);
  assert.equal(FK.parentAcross(host), doc);
});
