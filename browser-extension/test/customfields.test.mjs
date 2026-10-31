// Unit tests for custom fields filled by name (fillkit.js matcher, shared.js validator).
//   node --test browser-extension/test/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ crypto: webcrypto, Uint32Array, URL });
vm.runInContext(readFileSync(join(dir, "fillkit.js"), "utf8"), ctx);
vm.runInContext(readFileSync(join(dir, "shared.js"), "utf8"), ctx);
const FK = ctx.NotiqFill;
const NS = ctx.NotiqShared;
const plain = (o) => JSON.parse(JSON.stringify(o));

// A minimal stand-in for an <input>: attributes, labels and its root's getElementById.
function el({ tag = "INPUT", type, label, labels, ariaLabel, labelledby, placeholder, name, id, value = "", byId = {} } = {}) {
  const attrs = {};
  if (type !== undefined) attrs.type = type;
  if (ariaLabel !== undefined) attrs["aria-label"] = ariaLabel;
  if (labelledby !== undefined) attrs["aria-labelledby"] = labelledby;
  if (placeholder !== undefined) attrs.placeholder = placeholder;
  if (name !== undefined) attrs.name = name;
  if (id !== undefined) attrs.id = id;
  const ls = labels || (label !== undefined ? [label] : []);
  return {
    tagName: tag, type: type || "text", value,
    getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
    labels: ls.map((t) => ({ textContent: t })),
    getRootNode: () => ({ getElementById: (x) => (byId[x] !== undefined ? { textContent: byId[x] } : null) }),
  };
}
const cand = (e, extra = {}) => ({ texts: FK.describeField(e), value: e.value, clicked: false, excluded: false, ...extra });

// The bank login's custom fields.
const BANK = [
  { name: "Customer ID", value: "C-1001", secret: false },
  { name: "Membership No.", value: "M-42", secret: false },
  { name: "PIN", value: "4321", secret: true },
  { name: "Branch", value: "North", secret: false },
];
const filled = (customs, els, opts = { allowSecret: true }) =>
  plain(FK.matchCustomFields(customs, els.map((e) => (e.texts ? e : cand(e))), opts)).map((p) => [p.field, customs[p.custom].name]);

test("nameKey: case, spaces, punctuation, camelCase, accents and filler words don't matter", () => {
  const k = FK.nameKey;
  for (const v of ["Customer ID", "customerId", "customer_id", "CUSTOMER-ID", "Customer Id:", "customerid", "customerID",
    "Enter your customer ID", "Customer ID *", " customer.id "]) assert.equal(k(v), "customerid", v);
  for (const v of ["Membership No.", "membershipNumber", "membership_no", "Membership #", "membership-num", "MembershipNr"]) {
    assert.equal(k(v), "membershipnumber", v);
  }
  assert.equal(k("Numéro client"), "numberclient");
  assert.equal(k("PIN"), "pin");
  assert.equal(k("Your PIN"), "pin");
  assert.notEqual(k("PIN code"), "pin");
  assert.notEqual(k("PINCode"), "pin");
  assert.notEqual(k("spinner"), "pin");
  assert.equal(k("PINCode"), "pincode");
  assert.equal(k(""), "");
  assert.equal(k("***"), "");
  assert.equal(k(null), "");
  assert.equal(k("The"), "the"); // only filler words: kept as they are
  assert.equal(k("x".repeat(5000)).length, 200); // bounded
});

test("describeField: labels, aria-label, aria-labelledby, placeholder, name, id", () => {
  const e = el({ label: "Customer Id:", ariaLabel: "Cust", labelledby: "a b missing", placeholder: "12345", name: "cid", id: "c1",
    byId: { a: "Customer", b: "number" } });
  assert.deepEqual(plain(FK.describeField(e)), ["Customer Id:", "Cust", "Customer", "number", "12345", "cid", "c1"]);
  assert.deepEqual(plain(FK.describeField(el())), []);
});

test("customFillable: text-like inputs and textareas only", () => {
  for (const type of [undefined, "text", "email", "tel", "number", "password", "search", "url", "TEXT"]) {
    assert.equal(FK.customFillable(el({ type })), true, String(type));
  }
  for (const type of ["hidden", "checkbox", "radio", "file", "submit", "date", "range", "color"]) {
    assert.equal(FK.customFillable(el({ type })), false, type);
  }
  assert.equal(FK.customFillable(el({ tag: "TEXTAREA" })), true);
  assert.equal(FK.customFillable(el({ tag: "SELECT" })), false);
  assert.equal(FK.customFillable(null), false);
});

test("bank page: Customer ID, Membership No. and PIN each find their field; look-alikes stay empty", () => {
  const page = [
    el({ label: "Customer Id:", name: "customerId", id: "b-cust" }),          // 0
    el({ label: "Membership number", name: "membership_no" }),                 // 1
    el({ type: "password", label: "PIN", name: "pin" }),                       // 2
    el({ label: "PIN code (postal)", name: "pincode" }),                       // 3
    el({ label: "Spinner speed", name: "spinner" }),                           // 4
    el({ placeholder: "Enter your customer ID" }),                             // 5
    el({ id: "customer-pin" }),                                                // 6
    el({ ariaLabel: "Membership #" }),                                         // 7
  ];
  assert.deepEqual(filled(BANK, page), [[0, "Customer ID"], [1, "Membership No."], [2, "PIN"], [5, "Customer ID"], [7, "Membership No."]]);
});

test("secret custom fields only on the login's own site", () => {
  const page = [el({ label: "Customer ID" }), el({ type: "password", label: "PIN" })];
  assert.deepEqual(filled(BANK, page, { allowSecret: false }), [[0, "Customer ID"]]);
  assert.deepEqual(filled(BANK, page, {}), [[0, "Customer ID"]]);
  assert.deepEqual(filled(BANK, page), [[0, "Customer ID"], [1, "PIN"]]);
});

test("PIN vs password: the login's own password field (excluded) is never overwritten", () => {
  // The site calls its password "PIN": the fill put the password there, so the custom PIN must not replace it.
  const page = [
    cand(el({ label: "Customer ID", name: "userid" }), { excluded: true, value: "me" }), // the username field of this fill
    cand(el({ type: "password", label: "PIN", name: "pin" }), { excluded: true, value: "Login-Password" }),
    cand(el({ label: "Membership No." })),
  ];
  assert.deepEqual(filled(BANK, page), [[2, "Membership No."]]);
});

test("a field that already holds a value is kept, unless it is the one the user clicked", () => {
  const branch = el({ label: "Branch", value: "Main street" });
  assert.deepEqual(filled(BANK, [branch]), []);
  assert.deepEqual(filled(BANK, [cand(branch, { clicked: true })]), [[0, "Branch"]]);
  // Whitespace counts as a value (the user typed something).
  assert.deepEqual(filled(BANK, [el({ label: "Branch", value: " " })]), []);
});

test("first matching custom field wins; one custom field may fill several boxes", () => {
  const customs = [{ name: "Customer ID", value: "A", secret: false }, { name: "customer_id", value: "B", secret: false }];
  assert.deepEqual(filled(customs, [el({ label: "Customer ID" }), el({ name: "customerId" })]), [[0, "Customer ID"], [1, "Customer ID"]]);
});

test("customs without a value or name, and garbage input, match nothing", () => {
  const page = [el({ label: "Customer ID" })];
  assert.deepEqual(filled([{ name: "Customer ID", value: "", secret: false }], page), []);
  assert.deepEqual(filled([{ name: "", value: "x", secret: false }], page), []);
  assert.deepEqual(filled([{ name: "***", value: "x", secret: false }], [el({ label: "***" })]), []);
  assert.deepEqual(plain(FK.matchCustomFields(null, page)), []);
  assert.deepEqual(plain(FK.matchCustomFields(BANK, null)), []);
  assert.deepEqual(plain(FK.matchCustomFields([], [cand(page[0])])), []);
  assert.deepEqual(plain(FK.matchCustomFields(BANK, [null, { texts: "nope" }])), []);
});

test("validCustomFields: keeps good entries, drops bad ones one by one", () => {
  const good = { name: "Customer ID", value: "C-1", secret: false };
  assert.deepEqual(plain(NS.validCustomFields([
    good,
    { name: "PIN", value: "4321", secret: true },
    { name: " Notes\u0001 ", value: "line 1\nline 2\tend", secret: "yes" },
    { name: "", value: "x" },
    { name: "x".repeat(61), value: "x" },
    { name: "Big", value: "x".repeat(1025) },
    { name: "Empty", value: "" },
    { name: "Ctl", value: "a\u0000b" },
    { name: 1, value: "x" },
    null, "str", [good],
  ])), [good, { name: "PIN", value: "4321", secret: true }, { name: "Notes", value: "line 1\nline 2\tend", secret: false }]);
  for (const v of [undefined, null, "x", 3, {}]) assert.deepEqual(plain(NS.validCustomFields(v)), []);
  assert.equal(NS.validCustomFields(Array.from({ length: 40 }, () => good)).length, 20);
});
