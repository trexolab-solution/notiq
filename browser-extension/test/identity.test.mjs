// Unit tests for browser-extension/identity.js: identity (address / contact) field classification,
// form detection, reply validation and value mapping. Fixtures mirror real checkout forms, Indian ones included.
//   node --test browser-extension/test/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "identity.js"), "utf8");
const ctx = vm.createContext({});
vm.runInContext(src, ctx);
const NI = ctx.NotiqIdentity;
const plain = (o) => JSON.parse(JSON.stringify(o));

const input = (o) => ({ tag: "INPUT", type: "text", ...o });
const select = (o) => ({ tag: "SELECT", ...o });
const kind = (o) => { const r = NI.identityFieldKind(o); return r ? `${r.kind}${r.tagged ? "" : "?"}` : null; };
const kindsOf = (fields) => fields.map(kind);

test("autocomplete tokens win (with section / shipping / billing modifiers)", () => {
  assert.equal(kind(input({ autocomplete: "name" })), "name");
  assert.equal(kind(input({ autocomplete: "given-name", name: "x" })), "given");
  assert.equal(kind(input({ autocomplete: "family-name" })), "family");
  assert.equal(kind(input({ type: "email", autocomplete: "email" })), "email");
  assert.equal(kind(input({ type: "tel", autocomplete: "shipping tel" })), "tel");
  assert.equal(kind(input({ type: "tel", autocomplete: "tel-national" })), "tel");
  assert.equal(kind(input({ autocomplete: "section-ship shipping address-line1" })), "address1");
  assert.equal(kind(input({ autocomplete: "billing address-line2" })), "address2");
  assert.equal(kind({ tag: "TEXTAREA", autocomplete: "street-address" }), "street");
  assert.equal(kind(input({ autocomplete: "address-level2" })), "city");
  assert.equal(kind(select({ autocomplete: "address-level1" })), "state");
  assert.equal(kind(input({ autocomplete: "postal-code", name: "card_zip" })), "postal");
  assert.equal(kind(select({ autocomplete: "country" })), "country");
  assert.equal(kind(input({ autocomplete: "country-name" })), "country");
  assert.equal(kind(input({ autocomplete: "work email", type: "email" })), "email");
});

test("tokens that name another field are never identity fields", () => {
  for (const ac of ["username", "current-password", "new-password", "one-time-code", "cc-number", "cc-name",
    "organization", "address-line3", "address-level3", "bday", "nickname", "tel-country-code", "tel-extension"]) {
    assert.equal(kind(input({ autocomplete: ac, name: "email", placeholder: "Full name" })), null, ac);
  }
  // "off" / unknown tokens fall back to the heuristics.
  assert.equal(kind(input({ autocomplete: "off", name: "city" })), "city?");
  assert.equal(kind(input({ autocomplete: "nope", placeholder: "Mobile number" })), "tel?");
});

test("input types: text-like, select and textarea only; never password / hidden / checkbox", () => {
  for (const type of ["password", "hidden", "checkbox", "radio", "submit", "date", "file", "search"]) {
    assert.equal(kind(input({ type, autocomplete: "name", name: "fullname" })), null, type);
  }
  assert.equal(kind({ tag: "BUTTON", name: "city" }), null);
  assert.equal(kind(input({ type: "number", name: "pincode" })), "postal?");
  // Selects only for country / state / city; a textarea only for the street address.
  assert.equal(kind(select({ name: "title", label: "Name prefix" })), null);
  assert.equal(kind(select({ name: "city" })), "city?");
  assert.equal(kind({ tag: "TEXTAREA", name: "address", label: "Address" }), "street?");
  assert.equal(kind({ tag: "TEXTAREA", name: "message", label: "Your message" }), null);
  assert.equal(kind(select({ autocomplete: "email" })), null);
});

test("heuristics: labels, names, ids, placeholders", () => {
  assert.equal(kind(input({ label: "Full name" })), "name?");
  assert.equal(kind(input({ name: "firstName" })), "given?");
  assert.equal(kind(input({ id: "last_name" })), "family?");
  assert.equal(kind(input({ name: "surname" })), "family?");
  assert.equal(kind(input({ placeholder: "Email address" })), "email?");
  assert.equal(kind(input({ type: "email", name: "x1" })), "email?");
  assert.equal(kind(input({ type: "tel", name: "x2" })), "tel?");
  assert.equal(kind(input({ label: "Phone number" })), "tel?");
  assert.equal(kind(input({ name: "zipCode" })), "postal?");
  assert.equal(kind(input({ label: "Postcode" })), "postal?");
  assert.equal(kind(input({ name: "addressLine1" })), "address1?");
  assert.equal(kind(input({ name: "address_2" })), "address2?");
  assert.equal(kind(input({ label: "Street address" })), "address1?");
  assert.equal(kind(input({ label: "Apartment, suite, etc. (optional)" })), "address2?");
  assert.equal(kind(input({ label: "City" })), "city?");
  assert.equal(kind(input({ label: "State / Province" })), "state?");
  assert.equal(kind(input({ label: "Country/Region" })), "country?");
  assert.equal(kind(input({ label: "Address line 3" })), null);
});

test("heuristics leave other fields alone", () => {
  for (const f of [
    input({ name: "q", placeholder: "Search products" }), input({ name: "coupon", label: "Promo code" }),
    input({ label: "Username" }), input({ label: "Name on card" }), input({ label: "Company name" }),
    input({ label: "Landmark (optional)" }), input({ label: "Alternate phone (optional)" }), input({ label: "GSTIN" }),
    input({ label: "PAN" }), input({ label: "Date of birth" }), input({ label: "Delivery instructions" }),
    input({ name: "otp", label: "Enter OTP" }), input({ label: "Gift message" }), input({ label: "Quantity" }),
    input({ name: "captcha" }), input({ label: "Your feedback" }),
  ]) assert.equal(kind(f), null, JSON.stringify(f));
});

// Amazon.in "Add a new address" (labels and ids as on the live form).
const amazonIn = [
  select({ id: "address-ui-widgets-countryCode-dropdown-nativeId", name: "address-ui-widgets-countryCode", label: "Country/Region" }),
  input({ id: "address-ui-widgets-enterAddressFullName", name: "address-ui-widgets-enterAddressFullName", label: "Full name (First and Last name)", autocomplete: "name" }),
  input({ type: "tel", id: "address-ui-widgets-enterAddressPhoneNumber", name: "address-ui-widgets-enterAddressPhoneNumber", label: "Mobile number", autocomplete: "tel" }),
  input({ id: "address-ui-widgets-enterAddressPostalCode", name: "address-ui-widgets-enterAddressPostalCode", label: "Pincode", placeholder: "6 digits [0-9] PIN code", autocomplete: "postal-code" }),
  input({ id: "address-ui-widgets-enterAddressLine1", name: "address-ui-widgets-enterAddressLine1", label: "Flat, House no., Building, Company, Apartment", autocomplete: "address-line1" }),
  input({ id: "address-ui-widgets-enterAddressLine2", name: "address-ui-widgets-enterAddressLine2", label: "Area, Street, Sector, Village", autocomplete: "address-line2" }),
  input({ id: "address-ui-widgets-landmark", name: "address-ui-widgets-landmark", label: "Landmark", placeholder: "E.g. near apollo hospital" }),
  input({ id: "address-ui-widgets-enterAddressCity", name: "address-ui-widgets-enterAddressCity", label: "Town/City", autocomplete: "address-level2" }),
  select({ id: "address-ui-widgets-enterAddressStateOrRegion-dropdown-nativeId", name: "address-ui-widgets-enterAddressStateOrRegion", label: "State" }),
];

test("Amazon.in address form", () => {
  assert.deepEqual(kindsOf(amazonIn), ["country?", "name", "tel", "postal", "address1", "address2", null, "city", "state?"]);
  // The same form without autocomplete tokens is still read correctly from the labels and ids.
  const bare = amazonIn.map(({ autocomplete, ...f }) => f);
  assert.deepEqual(kindsOf(bare), ["country?", "name?", "tel?", "postal?", "address1?", "address2?", null, "city?", "state?"]);
  assert.equal(NI.isIdentityForm(bare.map((f) => NI.identityFieldKind(f))), true);
});

// Flipkart-style form: plain names, a textarea for the address, locality as line 2, alternate phone.
const flipkart = [
  input({ name: "name", label: "Name" }),
  input({ type: "tel", name: "phone", label: "10-digit mobile number", maxLength: 10 }),
  input({ name: "pincode", label: "Pincode", maxLength: 6 }),
  input({ name: "addressLine2", label: "Locality" }),
  { tag: "TEXTAREA", name: "addressLine1", label: "Address (Area and Street)" },
  input({ name: "city", label: "City/District/Town" }),
  select({ name: "state", label: "--Select State--" }),
  input({ name: "landmark", label: "Landmark (Optional)" }),
  input({ type: "tel", name: "alternatePhone", label: "Alternate Phone (Optional)" }),
];

test("Flipkart-style address form", () => {
  assert.deepEqual(kindsOf(flipkart), ["name?", "tel?", "postal?", "address2?", "street?", "city?", "state?", null, null]);
  // A one-box street address next to a line-2 field holds line 1 only.
  assert.deepEqual(plain(NI.resolveKinds(["name", "address2", "street", "city"])), ["name", "address2", "address1", "city"]);
  assert.deepEqual(plain(NI.resolveKinds(["name", "street", "city"])), ["name", "street", "city"]);
});

// A typical Indian D2C / Shopify checkout ("Apartment, suite", "PIN code", "Phone").
const shopifyIn = [
  input({ type: "email", name: "email", autocomplete: "shipping email", placeholder: "Email or mobile phone number" }),
  select({ name: "countryCode", autocomplete: "shipping country", label: "Country/Region" }),
  input({ name: "firstName", autocomplete: "shipping given-name", placeholder: "First name (optional)" }),
  input({ name: "lastName", autocomplete: "shipping family-name", placeholder: "Last name" }),
  input({ name: "address1", autocomplete: "shipping address-line1", placeholder: "Address" }),
  input({ name: "address2", autocomplete: "shipping address-line2", placeholder: "Apartment, suite, etc. (optional)" }),
  input({ name: "city", autocomplete: "shipping address-level2", placeholder: "City" }),
  select({ name: "zone", autocomplete: "shipping address-level1", label: "State" }),
  input({ name: "postalCode", autocomplete: "shipping postal-code", placeholder: "PIN code" }),
  input({ type: "tel", name: "phone", autocomplete: "shipping tel", placeholder: "Phone" }),
];

test("Shopify-style checkout (India)", () => {
  assert.deepEqual(kindsOf(shopifyIn), ["email", "country", "given", "family", "address1", "address2", "city", "state", "postal", "tel"]);
});

test("form detection: address and contact forms only", () => {
  const k = (...kinds) => kinds.map((x) => ({ kind: x, tagged: false }));
  assert.equal(NI.isIdentityForm(k("name", "tel", "postal")), true);
  assert.equal(NI.isIdentityForm(k("name", "email", "tel")), true); // contact form with a phone
  assert.equal(NI.isIdentityForm(k("email")), false); // newsletter
  assert.equal(NI.isIdentityForm(k("name", "email")), false); // "name + email + message"
  assert.equal(NI.isIdentityForm(k("given", "family", "email")), false); // sign-up without any address / phone
  assert.equal(NI.isIdentityForm([{ kind: "address1", tagged: true }, { kind: "postal", tagged: true }]), true);
  assert.equal(NI.isIdentityForm([{ kind: "city", tagged: true }, { kind: "name", tagged: false }]), false);
  assert.equal(NI.isIdentityForm([null, undefined]), false);
  assert.equal(NI.isIdentityForm("x"), false);
});

const id = {
  title: "Home", name: "Asha K Rao", email: "asha@example.com", phone: "+91 98765 43210", address1: "Flat 4B, Lake View Apts",
  address2: "MG Road, Indiranagar", city: "Bengaluru", state: "Karnataka", postal: "560 038", country: "India",
};

test("validIdentityReply: strict shape, caps, cleanup", () => {
  const ok = NI.validIdentityReply({ ok: true, ...id, extra: "ignored" });
  assert.deepEqual(plain(ok), id);
  assert.equal(NI.validIdentityReply({ ...id }), null); // no ok
  assert.equal(NI.validIdentityReply({ ok: true, ...id, name: 5 }), null);
  assert.equal(NI.validIdentityReply({ ok: true, ...id, postal: "1".repeat(21) }), null);
  assert.equal(NI.validIdentityReply({ ok: true }), null); // nothing to fill
  assert.equal(NI.validIdentityReply(null), null);
  assert.equal(NI.validIdentityReply([]), null);
  const messy = NI.validIdentityReply({ ok: true, name: " Asha\n\tRao ", email: "not an email", title: "Ho\u0007me" });
  assert.deepEqual(plain(messy), { name: "Asha Rao", email: "", phone: "", address1: "", address2: "", city: "", state: "",
    postal: "", country: "", title: "Ho me" });
});

test("validIdentityList: titles and safe account paths only", () => {
  const list = NI.validIdentityList({ ok: true, identities: [{ account: "Ids/Home.nqv", title: "Home" }, { account: "Office.nqv", title: " Office\n" }] });
  assert.deepEqual(plain(list), [{ account: "Ids/Home.nqv", title: "Home" }, { account: "Office.nqv", title: "Office" }]);
  assert.deepEqual(plain(NI.validIdentityList({ ok: true, identities: [] })), []);
  for (const bad of [{ account: "../x.nqv", title: "x" }, { account: "/abs", title: "x" }, { account: "C:x", title: "x" },
    { account: "a", title: "" }, { account: "a", title: 3 }, { account: "", title: "x" }, "x"]) {
    assert.equal(NI.validIdentityList({ ok: true, identities: [bad] }), null, JSON.stringify(bad));
  }
  assert.equal(NI.validIdentityList({ ok: true, identities: Array.from({ length: 21 }, (_, i) => ({ account: `${i}.nqv`, title: `${i}` })) }), null);
  assert.equal(NI.validIdentityList({ error: "locked" }), null);
});

test("splitName and countryCode", () => {
  assert.deepEqual(plain(NI.splitName("Asha K Rao")), { given: "Asha K", family: "Rao" });
  assert.deepEqual(plain(NI.splitName("  Asha  ")), { given: "Asha", family: "" });
  assert.deepEqual(plain(NI.splitName("")), { given: "", family: "" });
  assert.equal(NI.countryCode("India"), "IN");
  assert.equal(NI.countryCode("in"), "IN");
  assert.equal(NI.countryCode("United States of America"), "US");
  assert.equal(NI.countryCode("U.K."), "");
  assert.equal(NI.countryCode("UK"), "GB");
  assert.equal(NI.countryCode("Atlantis"), "");
});

const field = (o = {}) => ({ tag: "INPUT", type: "text", maxLength: -1, autocomplete: "", options: null, ...o });
const opts = (...pairs) => pairs.map(([value, text]) => ({ value, text }));

test("values: names, contact and address lines", () => {
  const v = (k, f) => NI.identityFieldValue(k, id, field(f));
  assert.equal(v("name"), "Asha K Rao");
  assert.equal(v("given"), "Asha K");
  assert.equal(v("family"), "Rao");
  assert.equal(v("email"), "asha@example.com");
  assert.equal(v("email", { maxLength: 10 }), null); // an email is never cut
  assert.equal(v("address1"), "Flat 4B, Lake View Apts");
  assert.equal(v("address2"), "MG Road, Indiranagar");
  assert.equal(v("street"), "Flat 4B, Lake View Apts, MG Road, Indiranagar");
  assert.equal(v("street", { tag: "TEXTAREA" }), "Flat 4B, Lake View Apts\nMG Road, Indiranagar");
  assert.equal(v("city"), "Bengaluru");
  assert.equal(v("state"), "Karnataka");
  assert.equal(v("country"), "India");
  assert.equal(v("country", { autocomplete: "shipping country" }), "IN"); // the token asks for the code
  assert.equal(v("country", { maxLength: 2 }), "IN");
  assert.equal(v("address1", { maxLength: 8 }), "Flat 4B,");
  assert.equal(NI.identityFieldValue("address2", { ...id, address2: "" }, field()), null); // empty: leave it
  assert.equal(NI.identityFieldValue("bogus", id, field()), null);
  assert.equal(NI.identityFieldValue("name", null, field()), null);
});

test("values: Indian phone and PIN fields", () => {
  const v = (k, f) => NI.identityFieldValue(k, id, field(f));
  assert.equal(v("tel"), "+91 98765 43210");
  assert.equal(v("tel", { maxLength: 10 }), "9876543210"); // "10-digit mobile number"
  assert.equal(v("tel", { autocomplete: "tel-national" }), "9876543210");
  assert.equal(v("tel", { type: "number" }), "9876543210");
  assert.equal(NI.identityFieldValue("tel", { ...id, phone: "080-2345 6789" }, field({ maxLength: 11 })), "08023456789");
  assert.equal(NI.identityFieldValue("tel", { ...id, phone: "98765 43210" }, field({ maxLength: 10 })), "9876543210");
  assert.equal(v("postal"), "560 038");
  assert.equal(v("postal", { maxLength: 6 }), "560038");
  assert.equal(v("postal", { type: "number" }), "560038");
  assert.equal(v("postal", { maxLength: 5 }), null); // doesn't fit even without the space
});

test("values: <select> options for country, state and city", () => {
  const sel = (k, options) => NI.identityFieldValue(k, id, { tag: "SELECT", options });
  const states = opts(["", "Select"], ["KA", "KARNATAKA"], ["KL", "KERALA"], ["JK", "Jammu & Kashmir"]);
  assert.equal(sel("state", states), "KA");
  assert.equal(NI.identityFieldValue("state", { ...id, state: "Jammu and Kashmir" }, { tag: "SELECT", options: states }), "JK");
  assert.equal(sel("state", opts(["29", "Karnataka (KA)"])), "29"); // text starts with the name
  assert.equal(sel("state", opts(["", "Karnataka"])), null); // a placeholder option never counts
  assert.equal(sel("country", opts(["", "Select"], ["US", "United States"], ["IN", "India"])), "IN");
  assert.equal(sel("country", opts(["356", "IN"])), "356"); // by code text
  assert.equal(sel("country", opts(["in", "Bharat"])), "in");
  assert.equal(NI.identityFieldValue("country", { ...id, country: "USA" }, { tag: "SELECT", options: opts(["us", "United States of America"]) }), "us");
  assert.equal(sel("country", opts(["np", "Nepal"])), null);
  assert.equal(sel("city", opts(["blr", "Bengaluru"], ["mys", "Mysuru"])), "blr");
  assert.equal(sel("name", opts(["a", "Asha K Rao"])), null); // only country / state / city selects
});

test("every fixture field maps to a value or is left alone", () => {
  for (const f of [...amazonIn, ...flipkart, ...shopifyIn]) {
    const r = NI.identityFieldKind(f);
    if (!r) continue;
    const opt = f.tag === "SELECT" ? opts(["IN", "India"], ["KA", "Karnataka"]) : null;
    const value = NI.identityFieldValue(r.kind, id, { ...f, options: opt });
    assert.ok(value === null || typeof value === "string", JSON.stringify(f));
  }
});
