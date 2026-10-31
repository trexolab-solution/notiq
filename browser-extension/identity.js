// Notiq Autofill — identity (name / contact / address) form helpers. Pure: no DOM access, no network,
// nothing kept. Exposed as a frozen `NotiqIdentity` global (the content script's isolated world, and the
// background, which validates the app's replies with it).
//
// Field kinds: "name" (full name), "given", "family", "email", "tel", "address1", "address2",
// "street" (one multi-line street address), "city", "state", "postal", "country".
(function (g) {
  "use strict";

  // ---------- classification ----------
  // autocomplete tokens (https://html.spec.whatwg.org/#autofill-field). The last field token wins;
  // section-*, shipping / billing and home / work / mobile / fax / pager are modifiers.
  const AC_KIND = Object.freeze({
    name: "name", "given-name": "given", "family-name": "family", email: "email", tel: "tel", "tel-national": "tel",
    "address-line1": "address1", "address-line2": "address2", "street-address": "street",
    "address-level2": "city", "address-level1": "state", "postal-code": "postal", country: "country", "country-name": "country",
  });
  // Tokens that name some other field: never an identity field, whatever its label says.
  const AC_OTHER = /^(username|current-password|new-password|one-time-code|webauthn|cc-[a-z-]+|organization(-title)?|address-line3|address-level[34]|bday(-[a-z]+)?|sex|url|photo|impp|honorific-(prefix|suffix)|nickname|additional-name|tel-(country-code|area-code|local(-prefix|-suffix)?|extension)|transaction-(currency|amount)|language)$/;
  const AC_MODIFIER = /^(section-.*|shipping|billing|home|work|mobile|fax|pager)$/;

  // Label / name / id / placeholder heuristics, in this order.
  // Never identity: search boxes, codes, credentials, payment, tax ids, dates, free text.
  const HARD_NO = /search|coupon|promo|voucher|gift|captcha|referr|\botp\b|one.?time|verification|security.?code|passw|passcode|user.?name|\blogin\b|\bcard\b|\bcvv|\bcvc|\bgst|\btax|\bvat\b|\bpan\b|aadha+r|\bssn\b|\bdob\b|birth|gender|quantity|\bqty\b|message|comment|feedback|subject|\bnotes?\b|instruction/;
  const LINE1 = /line.?1\b|\baddr(ess)?.?1\b/;
  const LINE2 = /line.?2\b|\baddr(ess)?.?2\b/;
  const LINE3 = /line.?3\b|\baddr(ess)?.?3\b/;
  // Indian-style first address line: "Flat, House no., Building, Company, Apartment".
  const FLAT = /\bflat\b|house.?(no|num)|\bbuilding\b|door.?no|\bh\.?\s?no\b|plot.?no/;
  const SOFT_NO = /company|organi[sz]ation|business|employer|landmark|altern|\balt\b|secondary|other.?phone|emergency/;
  const RULES = [
    ["email", /e.?mail/],
    ["tel", /phone|mobile|\btel\b|telephone|\bcell\b|whats.?app|contact.?(no|num)/],
    ["postal", /\bzip|postal|post.?code|postcode|pin.?code|pincode|\bpin\b/],
    ["country", /country|\bnation/],
    ["state", /\bstate\b|province|\bregion\b|\bcounty\b|prefecture/],
    ["city", /\bcity\b|\btown\b|\bdistrict\b|suburb|municipal/],
    // Names before the address words: ids like "enterAddressFullName" carry the form's prefix.
    // "Full name (First and Last name)" is one full-name field.
    ["name", /full.?name|your.?name|recipient|contact.?person/],
    ["given", /first.?name|given.?name|\bfname\b|forename/],
    ["family", /last.?name|surname|family.?name|\blname\b/],
    ["address2", /\bapartment|\bapt\b|\bsuite\b|\barea\b|locality|\bsector\b|colony|village|neighbou?rhood/],
    ["address1", /street|address|\baddr\b|\broad\b/],
    ["name", /\bname\b/],
  ];
  const INPUT_TYPES = new Set(["", "text", "email", "tel", "number"]);
  const SELECT_KINDS = new Set(["country", "state", "city"]);

  // The words a field shows about itself: name, id, placeholder and label, lower-case, camelCase and
  // _ / - split into words ("addressLine1" -> "address line1").
  const hintOf = (f) => [f.name, f.id, f.placeholder, f.label]
    .map((s) => String(s || "").slice(0, 200))
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase();

  // f: { tag, type, autocomplete, name, id, placeholder, label }. Returns { kind, tagged } or null;
  // `tagged` is true when an autocomplete token said so.
  function identityFieldKind(f) {
    if (!f || typeof f !== "object") return null;
    const tag = String(f.tag || "").toLowerCase();
    const type = tag === "select" ? "select" : tag === "textarea" ? "textarea" : String(f.type || "").toLowerCase();
    if (tag === "input" ? !INPUT_TYPES.has(type) : tag !== "select" && tag !== "textarea") return null;
    const ok = (kind, tagged) => {
      if (type === "select" && !SELECT_KINDS.has(kind)) return null;
      if (type === "textarea" && kind !== "street" && kind !== "address1") return null;
      return { kind: type === "textarea" ? "street" : kind, tagged };
    };
    const tokens = String(f.autocomplete || "").toLowerCase().trim().split(/\s+/).filter((t) => t && !AC_MODIFIER.test(t));
    const last = tokens[tokens.length - 1];
    if (last && Object.prototype.hasOwnProperty.call(AC_KIND, last)) return ok(AC_KIND[last], true);
    if (last && AC_OTHER.test(last)) return null;
    const hint = hintOf(f);
    if (HARD_NO.test(hint)) return null;
    if (LINE3.test(hint)) return null;
    if (LINE1.test(hint)) return ok("address1", false);
    if (LINE2.test(hint)) return ok("address2", false);
    if (FLAT.test(hint)) return ok("address1", false);
    if (SOFT_NO.test(hint)) return null;
    for (const [kind, re] of RULES) if (re.test(hint)) return ok(kind, false);
    if (type === "email") return ok("email", false);
    if (type === "tel") return ok("tel", false);
    return null;
  }

  // Is this group of fields (one form) an address / contact form? kinds: [{ kind, tagged }].
  // Three different kinds, at least one of them an address or phone field (so a newsletter box or a
  // "name + email + message" contact form gets no icon); two are enough when one is a tagged address field.
  const PLACE = new Set(["address1", "address2", "street", "city", "state", "postal", "country", "tel"]);
  function isIdentityForm(list) {
    if (!Array.isArray(list)) return false;
    const kinds = new Set(list.filter(Boolean).map((r) => r.kind));
    const hasPlace = [...kinds].some((k) => PLACE.has(k));
    if (kinds.size >= 3 && hasPlace) return true;
    return kinds.size >= 2 && list.some((r) => r && r.tagged && (r.kind === "address1" || r.kind === "street" || r.kind === "postal"));
  }

  // The kind each field of one form is filled as: a one-box street address ("street") holds only line 1
  // when the form also has a line-2 field. kinds: [kind] in page order -> [kind].
  function resolveKinds(kinds) {
    const list = Array.isArray(kinds) ? kinds : [];
    const hasLine2 = list.includes("address2");
    return list.map((k) => (k === "street" && hasLine2 ? "address1" : k));
  }

  // ---------- the app's replies ----------
  const MAX = Object.freeze({ name: 100, email: 200, phone: 40, address1: 200, address2: 200, city: 100, state: 100, postal: 20, country: 100 });
  const KEYS = Object.freeze(Object.keys(MAX));
  const oneLine = (s) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);

  // fill_identity reply -> a fresh { title, name, email, phone, address1, address2, city, state, postal, country }
  // or null. Every value must be a string within its cap (a missing one counts as empty); at least one is set.
  function validIdentityReply(res) {
    if (!isObj(res) || res.ok !== true) return null;
    const out = {};
    let any = false;
    for (const k of KEYS) {
      const v = res[k] === undefined ? "" : res[k];
      if (typeof v !== "string" || v.length > MAX[k]) return null;
      out[k] = oneLine(v);
      if (out[k]) any = true;
    }
    if (!any) return null;
    if (out.email && !/^[^\s@]+@[^\s@]+$/.test(out.email)) out.email = "";
    out.title = typeof res.title === "string" ? oneLine(res.title).slice(0, 200) : "";
    return out;
  }

  // An identity's vault path as the app sends it (same rule as the app's `validate_account`).
  const validAccount = (a) => typeof a === "string" && a.length > 0 && a.length <= 512 && !/[\u0000-\u001f\u007f]/.test(a) &&
    !/^[\\/]/.test(a) && !a.includes(":") && !a.includes("..");

  // identities reply -> [{ account, title }] (at most 20) or null.
  function validIdentityList(res) {
    if (!isObj(res) || res.ok !== true || !Array.isArray(res.identities) || res.identities.length > 20) return null;
    const out = [];
    for (const c of res.identities) {
      if (!isObj(c) || !validAccount(c.account) || typeof c.title !== "string") return null;
      const title = oneLine(c.title).slice(0, 60);
      if (!title) return null;
      out.push({ account: c.account, title });
    }
    return out;
  }

  // ---------- values ----------
  // "Asha K Rao" -> given "Asha K", family "Rao"; a single word is the given name.
  function splitName(full) {
    const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return { given: parts[0] || "", family: "" };
    return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1] };
  }

  // Country names forms use, by ISO 3166 alpha-2 code (the first name is the canonical one).
  const COUNTRIES = Object.freeze({
    IN: ["india", "bharat", "ind"], US: ["united states", "united states of america", "usa", "america"],
    GB: ["united kingdom", "uk", "great britain", "britain", "england", "gbr"], CA: ["canada", "can"],
    AU: ["australia", "aus"], NZ: ["new zealand", "nzl"], IE: ["ireland", "irl"], DE: ["germany", "deutschland", "deu"],
    FR: ["france", "fra"], ES: ["spain", "espana", "esp"], IT: ["italy", "italia", "ita"], NL: ["netherlands", "holland", "nld"],
    AE: ["united arab emirates", "uae", "are"], SA: ["saudi arabia", "sau"], SG: ["singapore", "sgp"], MY: ["malaysia", "mys"],
    NP: ["nepal", "npl"], BD: ["bangladesh", "bgd"], LK: ["sri lanka", "lka"], PK: ["pakistan", "pak"], JP: ["japan", "jpn"],
    CN: ["china", "chn"], BR: ["brazil", "brasil", "bra"], MX: ["mexico", "mex"], ZA: ["south africa", "zaf"],
  });
  const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  // ISO code for a country name / code ("India", "IN", "IND" -> "IN"), or "".
  function countryCode(name) {
    const n = norm(name);
    if (!n) return "";
    for (const [code, names] of Object.entries(COUNTRIES)) if (n === code.toLowerCase() || names.includes(n)) return code;
    return "";
  }

  // The <select> option for `want` (options: [{ value, text }]), as its value, or null. Exact matches on the
  // text or the value (ignoring case, accents, punctuation, "&" vs "and") first; for a country also its ISO
  // code and other names; then an option text that starts with the wanted name ("Karnataka (KA)").
  function pickTextOption(want, options, kind) {
    if (!Array.isArray(options) || !want) return null;
    const wants = new Set([norm(want)]);
    if (kind === "country") {
      const code = countryCode(want);
      if (code) { wants.add(code.toLowerCase()); for (const n of COUNTRIES[code]) wants.add(n); }
    }
    wants.delete("");
    if (!wants.size) return null;
    const real = options.filter((o) => o && String(o.value || "").trim() !== "");
    for (const o of real) if (wants.has(norm(o.text)) || wants.has(norm(o.value))) return String(o.value);
    const main = norm(want);
    if (main.length >= 4) for (const o of real) if (norm(o.text).startsWith(`${main} `)) return String(o.value);
    return null;
  }

  // The value to put into one identity field, or null to leave it alone.
  // id: from validIdentityReply; field: { tag, type, maxLength, autocomplete, options }.
  function identityFieldValue(kind, id, field) {
    if (!id || !field) return null;
    const tag = String(field.tag || "").toLowerCase();
    const select = tag === "select";
    const type = String(field.type || "").toLowerCase();
    const max = typeof field.maxLength === "number" && field.maxLength > 0 ? field.maxLength : 0;
    const tokens = String(field.autocomplete || "").toLowerCase().split(/\s+/);
    const cut = (v) => (v ? (max ? v.slice(0, max) : v) : null);
    const names = splitName(id.name);
    if (select) {
      if (kind === "country" || kind === "state" || kind === "city") return pickTextOption(id[kind], field.options, kind);
      return null;
    }
    switch (kind) {
      case "name": return cut(id.name);
      case "given": return cut(names.given);
      case "family": return cut(names.family);
      case "email": return id.email && (!max || id.email.length <= max) ? id.email : null; // never a cut email
      case "address1": return cut(id.address1);
      case "address2": return cut(id.address2);
      case "street": {
        const lines = [id.address1, id.address2].filter(Boolean);
        return cut(lines.join(tag === "textarea" ? "\n" : ", "));
      }
      case "city": return cut(id.city);
      case "state": return cut(id.state);
      case "country": {
        if (!id.country) return null;
        // `country` asks for the code; a short field can only hold one.
        const code = countryCode(id.country);
        if (code && (tokens.includes("country") || (max && max <= 3 && id.country.length > max))) return code;
        return cut(id.country);
      }
      case "postal": {
        let v = id.postal;
        if (!v) return null;
        if (type === "number" || (max && v.length > max)) v = v.replace(/\s+/g, "");
        return !max || v.length <= max ? v : null;
      }
      case "tel": {
        let v = id.phone;
        if (!v) return null;
        const digits = v.replace(/\D/g, "");
        // A national-number field (or one that can't hold the +country code): the last 10 digits.
        const national = tokens.includes("tel-national") || type === "number" || (max && v.length > max);
        if (national) v = v.trim().startsWith("+") && digits.length > 10 ? digits.slice(-10) : digits;
        if (max && v.length > max) v = digits.slice(-max);
        return v || null;
      }
    }
    return null;
  }

  const api = Object.freeze({
    identityFieldKind, isIdentityForm, resolveKinds, validIdentityReply, validIdentityList, splitName, countryCode, pickTextOption,
    identityFieldValue, IDENTITY_MAX: MAX,
  });
  try {
    Object.defineProperty(g, "NotiqIdentity", { value: api, writable: false, configurable: false, enumerable: false });
  } catch { /* already defined (script injected twice) */ }
})(typeof globalThis !== "undefined" ? globalThis : self);
