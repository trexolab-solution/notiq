// Unit tests for the payment-card helpers in browser-extension/shared.js (field detection, reply
// validation, value formatting).
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
const plain = (o) => JSON.parse(JSON.stringify(o));

const input = (o) => ({ tag: "INPUT", type: "text", ...o });
const kind = (o) => { const r = NS.cardFieldKind(o); return r ? `${r.kind}${r.tagged ? "" : "?"}` : null; };

test("cardFieldKind: autocomplete tokens win and are marked tagged", () => {
  assert.equal(kind(input({ autocomplete: "cc-number" })), "number");
  assert.equal(kind(input({ autocomplete: "section-pay billing cc-exp" })), "exp");
  assert.equal(kind(input({ autocomplete: "cc-exp-month" })), "month");
  assert.equal(kind({ tag: "SELECT", autocomplete: "cc-exp-year" }), "year");
  assert.equal(kind(input({ autocomplete: "cc-name", name: "username" })), "name");
  assert.equal(kind(input({ type: "password", autocomplete: "cc-csc" })), "csc");
  assert.equal(kind(input({ type: "tel", autocomplete: "CC-NUMBER" })), "number");
});

test("cardFieldKind: name / id / placeholder / label hints (untagged)", () => {
  assert.equal(kind(input({ name: "cardnumber" })), "number?");
  assert.equal(kind(input({ id: "cc_num" })), "number?");
  assert.equal(kind(input({ label: "Credit card number" })), "number?");
  assert.equal(kind(input({ name: "card-holder-name" })), "name?");
  assert.equal(kind(input({ label: "Name on card" })), "name?");
  assert.equal(kind(input({ placeholder: "MM / YY" })), "exp?");
  assert.equal(kind(input({ name: "expiry" })), "exp?");
  assert.equal(kind(input({ name: "exp_month" })), "month?");
  assert.equal(kind({ tag: "select", name: "expiration-year" }), "year?");
  assert.equal(kind({ tag: "select", id: "month" }), "month?");
  assert.equal(kind(input({ name: "cvc" })), "csc?");
  assert.equal(kind(input({ type: "password", label: "Security code (CVV)" })), "csc?");
});

test("cardFieldKind: ignores login, address, OTP and unrelated fields", () => {
  for (const f of [
    input({ name: "email" }), input({ name: "username" }), input({ type: "password", name: "password" }),
    input({ type: "password", name: "card_number" }), // a masked number would be odd: never treat a password field as one
    input({ autocomplete: "one-time-code", name: "security_code" }), input({ autocomplete: "username", name: "card" }),
    input({ name: "street" }), input({ type: "checkbox", name: "cardnumber" }), input({ type: "hidden", autocomplete: "cc-number" }),
    { tag: "TEXTAREA", name: "cardnumber" }, null, "x",
  ]) assert.equal(NS.cardFieldKind(f), null, JSON.stringify(f));
});

const REPLY = { ok: true, title: "Visa", name: "Ann Lee", number: "4242424242424242", exp_month: "08", exp_year: "2027", csc: "123" };

test("validCardReply accepts the app's reply and returns a fresh object", () => {
  assert.deepEqual(plain(NS.validCardReply(REPLY)),
    { title: "Visa", name: "Ann Lee", number: "4242424242424242", month: "08", year: "2027", csc: "123" });
  assert.deepEqual(plain(NS.validCardReply({ ...REPLY, exp_month: "", exp_year: "", csc: "", name: "", title: 5 })),
    { title: "", name: "", number: "4242424242424242", month: "", year: "", csc: "" });
  assert.equal(NS.validCardReply({ ...REPLY, title: "a\u0007b" }).title, "a b");
});

test("validCardReply rejects anything off", () => {
  const bad = [
    null, "x", [], { ...REPLY, ok: false }, { error: "denied" },
    { ...REPLY, number: "4242 4242 4242 4242" }, { ...REPLY, number: "4242" }, { ...REPLY, number: "1".repeat(20) },
    { ...REPLY, number: 4242424242424242 }, { ...REPLY, exp_month: "13" }, { ...REPLY, exp_month: "8" },
    { ...REPLY, exp_year: "27" }, { ...REPLY, exp_year: "1999" }, { ...REPLY, exp_year: "" }, { ...REPLY, exp_month: "" },
    { ...REPLY, csc: "12" }, { ...REPLY, csc: "12345" }, { ...REPLY, csc: "abc" }, { ...REPLY, name: "x".repeat(101) },
  ];
  for (const b of bad) assert.equal(NS.validCardReply(b), null, JSON.stringify(b));
  for (const k of ["number", "exp_month", "exp_year", "csc", "name"]) {
    const r = { ...REPLY };
    delete r[k];
    assert.equal(NS.validCardReply(r), null, k);
  }
});

const CARD = { title: "Visa", name: "Ann Lee", number: "4242424242424242", month: "08", year: "2027", csc: "123" };
const val = (k, f, card = CARD) => NS.cardFieldValue(k, card, { tag: "INPUT", maxLength: -1, placeholder: "", ...f });

test("cardFieldValue: number, name and CVC", () => {
  assert.equal(val("number", {}), "4242424242424242");
  assert.equal(val("number", { maxLength: 19 }), "4242424242424242");
  assert.equal(val("number", { maxLength: 12 }), null); // would be cut off: leave it alone
  assert.equal(val("name", {}), "Ann Lee");
  assert.equal(val("name", { maxLength: 3 }), "Ann");
  assert.equal(val("csc", { maxLength: 4 }), "123");
  assert.equal(val("csc", {}, { ...CARD, csc: "" }), null);
  assert.equal(val("name", {}, { ...CARD, name: "" }), null);
  assert.equal(val("number", { tag: "SELECT" }), null);
});

test("cardFieldValue: one MM/YY field follows its placeholder and length", () => {
  assert.equal(val("exp", {}), "08/27");
  assert.equal(val("exp", { placeholder: "MM / YY" }), "08 / 27");
  assert.equal(val("exp", { placeholder: "MM / YY", maxLength: 5 }), "08/27");
  assert.equal(val("exp", { placeholder: "MM/YYYY" }), "08/2027");
  assert.equal(val("exp", { placeholder: "MM-YY" }), "08-27");
  assert.equal(val("exp", { maxLength: 4 }), "0827");
  assert.equal(val("exp", { placeholder: "MM/YYYY", maxLength: 5 }), "08/27");
  assert.equal(val("exp", {}, { ...CARD, month: "", year: "" }), null);
});

test("cardFieldValue: separate month / year inputs", () => {
  assert.equal(val("month", {}), "08");
  assert.equal(val("year", {}), "2027");
  assert.equal(val("year", { maxLength: 2 }), "27");
  assert.equal(val("year", { placeholder: "YY" }), "27");
});

const opts = (...pairs) => pairs.map(([value, text]) => ({ value, text: text ?? value }));
test("cardFieldValue: month / year selects pick the matching option's value", () => {
  const sel = (options) => ({ tag: "SELECT", options });
  assert.equal(val("month", sel(opts(["", "Month"], ["1"], ["8"], ["12"]))), "8");
  assert.equal(val("month", sel(opts(["01"], ["08"]))), "08");
  assert.equal(val("month", sel(opts(["a", "01 - January"], ["h", "08 - August"]))), "h");
  assert.equal(val("month", sel(opts(["jan", "January"], ["aug", "August"]))), "aug");
  assert.equal(val("month", sel(opts(["x", "Jan"], ["y", "Aug"]))), "y");
  assert.equal(val("month", sel(opts(["1"], ["2"]))), null);
  assert.equal(val("year", sel(opts(["", "Year"], ["2026"], ["2027"]))), "2027");
  assert.equal(val("year", sel(opts(["26"], ["27"]))), "27");
  assert.equal(val("year", sel(opts(["a", "2026"], ["b", "2027"]))), "b");
  assert.equal(val("year", sel(opts(["2030"]))), null);
  assert.equal(val("exp", sel(opts(["08/27"]))), null); // combined selects are left alone
});
