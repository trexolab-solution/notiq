// Unit tests for the popup's password generator (generator.js).  node --test browser-extension/test/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ crypto: globalThis.crypto, Uint32Array });
vm.runInContext(readFileSync(join(dir, "generator.js"), "utf8"), ctx);
const G = ctx.NotiqGen;
const plain = (o) => JSON.parse(JSON.stringify(o));
const ALL = { length: 20, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: false };

test("defaults mirror the app", () => {
  assert.deepEqual(plain(G.DEFAULTS), { length: 20, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: true });
  assert.equal(G.MIN_LENGTH, 8);
  assert.equal(G.MAX_LENGTH, 64);
  assert.ok(Object.isFrozen(G));
});

test("sanitize clamps length and keeps one class on", () => {
  assert.equal(G.sanitize({ length: 3 }).length, 8);
  assert.equal(G.sanitize({ length: 500 }).length, 64);
  assert.equal(G.sanitize({ length: "abc" }).length, 20);
  assert.equal(G.sanitize(null).length, 20);
  const none = G.sanitize({ lower: false, upper: false, digits: false, symbols: false });
  assert.equal(none.lower, true);
});

test("length is exact across the range", () => {
  for (let n = 8; n <= 64; n += 7) assert.equal(G.generate({ ...ALL, length: n }).length, n);
});

test("every enabled class is present, disabled ones never", () => {
  const classes = { lower: /[a-z]/, upper: /[A-Z]/, digits: /[0-9]/, symbols: /[!@#$%^&*\-_=+?]/ };
  for (let i = 0; i < 300; i++) {
    const o = { length: 8, lower: !!(i & 1), upper: !!(i & 2), digits: !!(i & 4), symbols: !!(i & 8), avoidAmbiguous: !!(i & 16) };
    const s = G.sanitize(o);
    const pw = G.generate(o);
    for (const [k, re] of Object.entries(classes)) assert.equal(re.test(pw), s[k], `${k} in ${JSON.stringify(s)}`);
  }
});

test("avoid ambiguous drops l I O 0 1", () => {
  for (let i = 0; i < 200; i++) assert.doesNotMatch(G.generate({ ...ALL, avoidAmbiguous: true, length: 64 }), /[lIO01]/);
  const seen = new Set();
  for (let i = 0; i < 200; i++) for (const c of G.generate({ ...ALL, length: 64 })) seen.add(c);
  for (const c of "lIO01") assert.ok(seen.has(c), c);
});

test("randomBelow: rejection sampling throws away the biased tail", () => {
  const draws = [0xffffffff, 7]; // for n=3 the limit is 4294967295, so the first draw is rejected
  let calls = 0;
  const v = G.randomBelow(3, (a) => { a[0] = draws[calls++]; });
  assert.equal(calls, 2);
  assert.equal(v, 7 % 3);
  calls = 0; // powers of two never reject
  G.randomBelow(8, (a) => { calls++; a[0] = 0xffffffff; });
  assert.equal(calls, 1);
});

test("randomBelow: bounds and bad input", () => {
  for (let i = 0; i < 1000; i++) assert.ok(G.randomBelow(10) < 10);
  assert.equal(G.randomBelow(1), 0);
  assert.throws(() => G.randomBelow(0));
  assert.throws(() => G.randomBelow(1.5));
});

test("randomBelow is roughly uniform", () => {
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 20000; i++) counts[G.randomBelow(10)]++;
  for (let d = 0; d < 10; d++) assert.ok(counts[d] > 1700 && counts[d] < 2300, `digit ${d}: ${counts[d]}`);
});

test("strength grows with length and pool", () => {
  const weak = G.strength({ length: 8, lower: true, upper: false, digits: false, symbols: false });
  const strong = G.strength({ ...ALL, length: 20 });
  assert.equal(weak.label, "Weak");
  assert.ok(strong.bits > weak.bits);
  assert.equal(strong.label, "Very strong");
});
