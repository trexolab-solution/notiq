// Notiq Autofill — pure helpers for the content script's form filling: the
// site-aware password generator (maxlength / minlength / passwordrules / simple
// pattern) and the walk through open shadow roots. No network, no secrets kept,
// no DOM access at load. Exposed as a frozen `NotiqFill` global (in the
// extension's isolated world when loaded as a content script).
(function (g) {
  "use strict";

  // ---------- password generator ----------
  // No look-alikes (I l 1 O o 0) in the default classes.
  const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const LOWER = "abcdefghijkmnpqrstuvwxyz";
  const DIGIT = "23456789";
  const SPECIAL = "!#$%&*+-=?@^_";
  const DEFAULT_CLASSES = Object.freeze([UPPER, LOWER, DIGIT, SPECIAL]);
  // Every ASCII special character (the passwordrules "special" class); used only to
  // check the characters a site lists itself, never to widen our own alphabet.
  const ASCII_SPECIAL = "-~!@#$%^&*_+=`|(){}[:;\"'<>,.?] /\\";
  const CLASS_CHARS = Object.freeze({
    upper: UPPER, lower: LOWER, digit: DIGIT, special: SPECIAL,
    "ascii-printable": UPPER + LOWER + DIGIT + SPECIAL, unicode: UPPER + LOWER + DIGIT + SPECIAL,
  });
  const DEFAULT_LEN = 20;   // what we generate when the site allows it
  const MIN_LEN = 12;       // we never go below this unless the site's maximum is lower
  const MAX_LEN = 128;      // a site minimum above this is treated as impossible
  const MAX_TRIES = 4000;

  const uniq = (s) => Array.from(new Set(Array.from(s))).join("");
  const toInt = (v) => {
    const n = typeof v === "number" ? v : /^\s*\d{1,4}\s*$/.test(String(v || "")) ? Number(v) : NaN;
    return Number.isInteger(n) && n > 0 ? n : 0;
  };

  // A passwordrules class list ("upper, digit, [-_!]") as a string of characters.
  // Unknown class names are ignored; custom [...] keeps printable ASCII only.
  function classListChars(value) {
    let out = "";
    const re = /\[([^\]]*)\]|([a-z-]+)/gi;
    let m;
    while ((m = re.exec(value))) {
      if (m[1] !== undefined) {
        for (const c of m[1]) if (c >= " " && c <= "~") out += c;
      } else {
        const name = m[2].toLowerCase();
        if (Object.prototype.hasOwnProperty.call(CLASS_CHARS, name)) out += CLASS_CHARS[name];
      }
    }
    return uniq(out);
  }

  // Parses the `passwordrules` attribute (WHATWG / Apple proposal):
  //   "minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; allowed: [-_]; max-consecutive: 2"
  // Returns { required: [chars], allowed: chars|null, minlength, maxlength, maxConsecutive }.
  function parsePasswordRules(text) {
    const out = { required: [], allowed: null, minlength: 0, maxlength: 0, maxConsecutive: 0 };
    if (typeof text !== "string" || !text.trim() || text.length > 2000) return out;
    for (const part of text.split(";")) {
      const k = part.indexOf(":");
      if (k < 0) continue;
      const name = part.slice(0, k).trim().toLowerCase();
      const value = part.slice(k + 1).trim();
      if (name === "required") {
        // Kept even when empty (nothing we can type): such a rule can't be met.
        if (value) out.required.push(classListChars(value));
      } else if (name === "allowed") {
        out.allowed = uniq((out.allowed || "") + classListChars(value));
      } else if (name === "minlength") {
        out.minlength = Math.max(out.minlength, toInt(value));
      } else if (name === "maxlength") {
        const n = toInt(value);
        if (n) out.maxlength = out.maxlength ? Math.min(out.maxlength, n) : n;
      } else if (name === "max-consecutive") {
        const n = toInt(value);
        if (n) out.maxConsecutive = out.maxConsecutive ? Math.min(out.maxConsecutive, n) : n;
      }
    }
    return out;
  }

  // The `pattern` attribute, when it is simple: one character class (or ".") with a
  // length range, e.g. "[A-Za-z0-9!@#]{8,16}", "\w{10,}", ".{8,64}". Returns
  // { allowed: chars|null, minlength, maxlength } or null when it is anything else.
  // (Any pattern is still checked against the final password; see generateFor.)
  function simplePattern(pattern) {
    if (typeof pattern !== "string" || !pattern || pattern.length > 300) return null;
    const m = /^\^?(\[(?:\\.|[^\]\\])+\]|\\[wdWD]|\.)(?:\{(\d{1,4})(?:,(\d{0,4}))?\}|([+*]))?\$?$/.exec(pattern);
    if (!m) return null;
    let min = 0, max = 0;
    if (m[2] !== undefined) {
      min = Number(m[2]);
      max = m[3] === undefined ? min : m[3] === "" ? 0 : Number(m[3]);
    } else if (m[4] === "+") min = 1;
    else if (m[4] === undefined) { min = 1; max = 1; }
    let allowed = null;
    if (m[1] !== ".") {
      let re;
      try { re = new RegExp(`^${m[1]}$`, "u"); } catch { try { re = new RegExp(`^${m[1]}$`); } catch { return null; } }
      const pool = uniq(UPPER + LOWER + DIGIT + SPECIAL + ASCII_SPECIAL + "Il1O0o");
      allowed = Array.from(pool).filter((c) => re.test(c)).join("");
    }
    return { allowed, minlength: min, maxlength: max };
  }

  // Whole-value test for a pattern attribute (as the browser applies it), or null.
  function patternTester(pattern) {
    if (typeof pattern !== "string" || !pattern || pattern.length > 500) return null;
    for (const flags of ["v", "u"]) {
      try { const re = new RegExp(`^(?:${pattern})$`, flags); return (s) => re.test(s); } catch { /* next */ }
    }
    return null;
  }

  // Works out what to generate for a set of fields.
  // c: { maxLength, minLength, rules, pattern } (maxLength/minLength as the DOM gives
  // them, -1 / 0 meaning none; rules = the passwordrules attribute text).
  // Returns { length, alphabet, required: [chars], maxConsecutive, test, limited, impossible, reason }.
  function planPassword(c, opts) {
    const o = Object.assign({ length: DEFAULT_LEN, floor: MIN_LEN }, opts || {});
    const rules = parsePasswordRules(c && c.rules);
    const pat = simplePattern(c && c.pattern);
    const test = patternTester(c && c.pattern);
    const maxes = [toInt(c && c.maxLength), rules.maxlength, pat ? pat.maxlength : 0].filter((n) => n > 0);
    const max = maxes.length ? Math.min(...maxes) : 0;
    const min = Math.max(toInt(c && c.minLength), rules.minlength, pat ? pat.minlength : 0);

    // Alphabet: the site's allowed + required characters when it lists any, else ours.
    const listed = rules.allowed !== null || rules.required.length > 0;
    let alphabet = listed ? uniq((rules.allowed || "") + rules.required.join("")) : DEFAULT_CLASSES.join("");
    if (pat && pat.allowed !== null) alphabet = Array.from(alphabet).filter((ch) => pat.allowed.includes(ch)).join("");
    const fit = (set) => Array.from(set).filter((ch) => alphabet.includes(ch)).join("");
    // Required classes: the site's, else one of each of our classes it allows.
    let required = (rules.required.length ? rules.required : DEFAULT_CLASSES).map(fit);
    const siteRequiredLost = rules.required.length && required.some((s) => !s);
    required = required.filter(Boolean);

    let length = o.length;
    if (max) length = Math.min(length, max);
    if (min) length = Math.max(length, min);
    if (length < o.floor && (!max || max >= o.floor)) length = o.floor;
    // Our own "one of each class" gives way on very short fields; a site's own requirement never does.
    if (!rules.required.length && length < required.length) required = required.slice(0, length);

    let reason = "";
    if (!alphabet) reason = "no allowed characters";
    else if (siteRequiredLost) reason = "required characters not allowed";
    else if (max && min > max) reason = "minimum longer than maximum";
    else if (length > MAX_LEN) reason = "length too long";
    else if (length < required.length) reason = "too short for the required characters";
    else if (rules.maxConsecutive === 1 && alphabet.length < 2) reason = "too few characters";
    return {
      length, max, alphabet, required, maxConsecutive: rules.maxConsecutive, test,
      limited: length !== o.length, impossible: !!reason, reason,
    };
  }

  function cryptoIndex(n) {
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    for (;;) {
      g.crypto.getRandomValues(buf);
      if (buf[0] < limit) return buf[0] % n;
    }
  }

  const runTooLong = (s, k) => {
    if (!k) return false;
    let run = 1;
    for (let i = 1; i < s.length; i++) {
      run = s[i] === s[i - 1] ? run + 1 : 1;
      if (run > k) return true;
    }
    return false;
  };

  // Draws uniformly from the plan's alphabet; a password missing a required class,
  // with too long a run, or failing the pattern is thrown away and drawn again
  // (uniform over all valid passwords, no shuffle needed). null after MAX_TRIES.
  function drawPassword(plan, rand) {
    const pick = rand || cryptoIndex;
    const a = plan.alphabet;
    for (let t = 0; t < MAX_TRIES; t++) {
      let out = "";
      for (let i = 0; i < plan.length; i++) out += a[pick(a.length)];
      if (!plan.required.every((set) => Array.from(out).some((ch) => set.includes(ch)))) continue;
      if (runTooLong(out, plan.maxConsecutive)) continue;
      if (plan.test && !plan.test(out)) continue;
      return out;
    }
    return null;
  }

  // The generator the content script uses. Returns
  // { password, length, limited, fallback, reason }: `fallback` is true when the
  // site's constraints could not be met and Notiq's default password was made
  // instead (still no longer than the site's maximum, so the site never cuts it).
  function generateFor(c, opts) {
    const rand = opts && opts.rand;
    const plan = planPassword(c, opts);
    const pw = plan.impossible ? null : drawPassword(plan, rand);
    if (pw) return { password: pw, length: pw.length, limited: plan.limited, fallback: false, reason: "" };
    let def = planPassword(plan.max ? { maxLength: plan.max } : {}, opts);
    let fallback = def.impossible ? null : drawPassword(def, rand);
    if (!fallback) { def = planPassword({}, opts); fallback = drawPassword(def, rand); }
    return { password: fallback, length: fallback.length, limited: def.limited, fallback: true, reason: plan.reason || "rules not met" };
  }

  // Merges the constraints of several fields (a new password and its confirm field).
  // f: [{ maxLength, minLength, rules, pattern }]. The smallest maximum and largest
  // minimum win; the first non-empty rules / pattern is used.
  function mergeConstraints(list) {
    const out = { maxLength: 0, minLength: 0, rules: "", pattern: "" };
    for (const f of Array.isArray(list) ? list : []) {
      if (!f) continue;
      const mx = toInt(f.maxLength);
      if (mx) out.maxLength = out.maxLength ? Math.min(out.maxLength, mx) : mx;
      out.minLength = Math.max(out.minLength, toInt(f.minLength));
      if (!out.rules && typeof f.rules === "string" && f.rules.trim()) out.rules = f.rules;
      if (!out.pattern && typeof f.pattern === "string" && f.pattern) out.pattern = f.pattern;
    }
    return out;
  }

  // ---------- open shadow roots ----------
  // Elements matching `selector` under `root`, in tree order, including those inside
  // OPEN shadow roots (recursively; closed roots are invisible by design). Bounded:
  // at most `maxDepth` nested roots and `maxRoots` roots in total. `skip(el)` hosts
  // are not entered (our own overlay host).
  function deepQuery(root, selector, opts) {
    const o = Object.assign({ maxDepth: 6, maxRoots: 200, skip: null }, opts || {});
    const out = [];
    let roots = 0;
    const walk = (scope, depth) => {
      let all;
      try { all = scope.querySelectorAll("*"); } catch { return; }
      for (let i = 0; i < all.length; i++) {
        const n = all[i];
        if (n.matches && n.matches(selector)) out.push(n);
        const sr = n.shadowRoot;
        if (sr && depth < o.maxDepth && roots < o.maxRoots && !(o.skip && o.skip(n))) {
          roots++;
          walk(sr, depth + 1);
        }
      }
    };
    walk(root, 0);
    return out;
  }

  // Every open shadow root under `root` (same bounds as deepQuery).
  function shadowRoots(root, opts) {
    const o = Object.assign({ maxDepth: 6, maxRoots: 200, skip: null }, opts || {});
    const out = [];
    const walk = (scope, depth) => {
      let all;
      try { all = scope.querySelectorAll("*"); } catch { return; }
      for (let i = 0; i < all.length && out.length < o.maxRoots; i++) {
        const n = all[i];
        const sr = n.shadowRoot;
        if (sr && depth < o.maxDepth && !(o.skip && o.skip(n))) {
          out.push(sr);
          walk(sr, depth + 1);
        }
      }
    };
    walk(root, 0);
    return out;
  }

  // The element that really has focus, through open shadow roots.
  function deepActive(doc) {
    let a = doc && doc.activeElement;
    for (let i = 0; a && a.shadowRoot && a.shadowRoot.activeElement && i < 16; i++) a = a.shadowRoot.activeElement;
    return a || null;
  }

  // The parent element, stepping out of a shadow root to its host.
  const parentAcross = (n) => (n && (n.parentElement || (n.parentNode && n.parentNode.host))) || null;

  const api = Object.freeze({
    DEFAULT_LEN, MIN_LEN, DEFAULT_CLASSES,
    parsePasswordRules, simplePattern, planPassword, drawPassword, generateFor, mergeConstraints,
    deepQuery, shadowRoots, deepActive, parentAcross,
  });
  try {
    Object.defineProperty(g, "NotiqFill", { value: api, writable: false, configurable: false, enumerable: false });
  } catch { /* already defined (script injected twice) */ }
})(typeof globalThis !== "undefined" ? globalThis : self);
