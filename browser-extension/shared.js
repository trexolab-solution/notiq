// Notiq Autofill — small pure helpers shared by the service worker, the popup
// and the content script (loaded before each of them). No DOM access at load,
// no network, no secrets. Exposed as a frozen `NotiqShared` global; in a content
// script that global lives in the extension's isolated world, not the page's.
(function (g) {
  "use strict";

  // ---------- theme (from the Notiq app, via the native host) ----------
  const HEX = /^#[0-9a-f]{6}$/i;
  const THEME_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const COLOR_KEYS = Object.freeze(["bg", "bgSecondary", "bgTertiary", "text", "textMuted", "border",
    "primary", "primaryText", "danger", "success"]);
  // Theme key -> CSS custom property used by every surface the extension draws.
  const CSS_VARS = Object.freeze({
    bg: "--nq-bg", bgSecondary: "--nq-bg2", bgTertiary: "--nq-bg3", text: "--nq-text", textMuted: "--nq-muted",
    border: "--nq-border", primary: "--nq-primary", primaryText: "--nq-on-primary", danger: "--nq-danger",
    success: "--nq-success",
  });
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // Returns a fresh, plain { id, mode, ...colours } object, or null when anything
  // is off. Extra keys are ignored (never copied); colours are lower-cased.
  function validateTheme(t) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return null;
    if (Object.keys(t).length > 32) return null;
    if (!own(t, "id") || typeof t.id !== "string" || !THEME_ID.test(t.id)) return null;
    if (!own(t, "mode") || (t.mode !== "dark" && t.mode !== "light")) return null;
    const out = { id: t.id, mode: t.mode };
    for (const k of COLOR_KEYS) {
      const v = own(t, k) ? t[k] : undefined;
      if (typeof v !== "string" || !HEX.test(v)) return null;
      out[k] = v.toLowerCase();
    }
    return out;
  }

  // Built-in fallbacks (the Notiq app's own Dark / Light themes), used when the
  // app hasn't shared a theme; picked by the OS colour scheme.
  const DEFAULT_THEMES = Object.freeze({
    dark: Object.freeze({ id: "notiq-dark", mode: "dark", bg: "#0f172a", bgSecondary: "#1e293b", bgTertiary: "#334155",
      text: "#e2e8f0", textMuted: "#94a3b8", border: "#334155", primary: "#c9a84c", primaryText: "#0f172a",
      danger: "#f87171", success: "#4ade80" }),
    light: Object.freeze({ id: "notiq-light", mode: "light", bg: "#ffffff", bgSecondary: "#f1f5f9", bgTertiary: "#e2e8f0",
      text: "#1e293b", textMuted: "#64748b", border: "#cbd5e1", primary: "#b45309", primaryText: "#ffffff",
      danger: "#dc2626", success: "#16a34a" }),
  });
  const resolveTheme = (cached, prefersDark) =>
    validateTheme(cached) || { ...(prefersDark ? DEFAULT_THEMES.dark : DEFAULT_THEMES.light) };

  // Sets the theme on an element as custom properties. Only validated values are
  // ever written, one property at a time (no CSS text is built from the theme).
  function applyTheme(elem, cached, prefersDark) {
    const t = resolveTheme(cached, prefersDark);
    for (const k of COLOR_KEYS) elem.style.setProperty(CSS_VARS[k], t[k]);
    elem.style.setProperty("color-scheme", t.mode);
    elem.setAttribute("data-nq-mode", t.mode);
    return t;
  }

  // What the service worker does with a `{op:"theme"}` reply:
  //   { action: "set", theme } | { action: "clear" } | { action: "keep" }.
  // App unreachable -> keep the cached theme. An older app that doesn't know the
  // op (or any other definite error) -> no theme. A malformed theme -> rejected,
  // the cache is left alone.
  const UNREACHABLE = new Set(["no_host", "app_not_running", "timeout", "no_reply", "failed", "busy", "locked"]);
  function themeReplyAction(res) {
    if (!res || typeof res !== "object" || Array.isArray(res)) return { action: "keep" };
    if (res.ok === true) {
      if (res.theme === null) return { action: "clear" };
      const theme = validateTheme(res.theme);
      return theme ? { action: "set", theme } : { action: "keep" };
    }
    if (typeof res.error === "string" && !UNREACHABLE.has(res.error)) return { action: "clear" };
    return { action: "keep" };
  }
  const sameTheme = (a, b) => {
    if (!a || !b) return !a && !b;
    return a.id === b.id && a.mode === b.mode && COLOR_KEYS.every((k) => a[k] === b[k]);
  };

  // ---------- "Fill with Notiq" suggestion under a focused login field ----------
  // s: { showIcon, suggestOnFocus, detected, dismissed, menuOpen, filling, typed, rect, viewport }
  // rect/viewport are plain numbers (DOMRect-like). Field must be a detected login field
  // (the same detector that places the key icon) that is big enough and on screen.
  const MIN_W = 120, MIN_H = 16;
  function shouldSuggest(s) {
    if (!s || s.showIcon === false || s.suggestOnFocus === false) return false;
    if (!s.detected || s.dismissed || s.menuOpen || s.filling || s.typed) return false;
    const r = s.rect, v = s.viewport;
    if (!r || !v) return false;
    if (!(r.width >= MIN_W && r.height >= MIN_H)) return false;
    return r.bottom > 0 && r.top < v.height && r.right > 0 && r.left < v.width;
  }

  // Where the dropdown goes: under the field, left-aligned with it, clamped to the
  // viewport; above the field when there is no room below. Width follows the field
  // within [minW, maxW]. Returns null when the field is off screen.
  function suggestPosition(rect, height, viewport, opts) {
    const o = Object.assign({ gap: 4, margin: 8, minW: 200, maxW: 320 }, opts || {});
    const vw = viewport.width, vh = viewport.height;
    if (!(rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw)) return null;
    const width = Math.max(0, Math.min(Math.max(rect.width, o.minW), o.maxW, vw - 2 * o.margin));
    const left = Math.max(o.margin, Math.min(vw - width - o.margin, rect.left));
    let top = rect.bottom + o.gap, placement = "below";
    if (top + height > vh - o.margin && rect.top - o.gap - height >= o.margin) {
      top = rect.top - o.gap - height;
      placement = "above";
    }
    return { left: Math.round(left), top: Math.round(top), width: Math.round(width), placement };
  }

  const rectsOverlap = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  // ---------- payment cards ----------
  // Field kinds: "number", "exp" (one MM/YY field), "month", "year", "name", "csc".
  const CC_TOKENS = Object.freeze({
    "cc-number": "number", "cc-exp": "exp", "cc-exp-month": "month", "cc-exp-year": "year", "cc-name": "name", "cc-csc": "csc",
  });
  // Name / id / placeholder / label heuristics, tried in this order (the CVC first: "card code"; the
  // name before the number: "card holder name").
  const CC_HINTS = [
    ["csc", /\b(cvc2?|cvv2?|csc|cvn|cid)\b|security.?code|card.?code|card.?verification|verification.?(code|number)|prüfnummer|kartenprüf/i],
    ["month", /exp\w*.?(month|mm\b|mon\b)|(month|\bmm)\w*.?exp|(card|cc).?month|exp_?m\b|expmonth|ablaufmonat|mes.?de.?(caducidad|vencimiento)/i],
    ["year", /exp\w*.?(year|yy\b|yr\b)|(year|\byy)\w*.?exp|(card|cc).?year|exp_?y\b|expyear|ablaufjahr|a[ñn]o.?de.?(caducidad|vencimiento)/i],
    ["exp", /expir|exp.?date|\bexp\b|valid.?(thru|through|until)|mm.?\/.?(yy|aa|jj)|ablauf|g[üu]ltig.?bis|caducidad|vencimiento|date.?d.?expiration/i],
    ["name", /card.?holder|holder.?name|name.?on.?(the.?)?card|nameoncard|(card|cc).?name|karteninhaber|titular/i],
    ["number", /(card|cc).?(number|num|no)\b|cardnumber|ccnum|credit.?card|card.?#|kartennummer|n[uú]mero.?de.?(la.?)?tarjeta|num[eé]ro.?de.?carte/i],
    // Bare "Month" / "Year" selects next to a card number (after the MM/YY rule above).
    ["month", /\b(month|mm|mon)\b/i],
    ["year", /\b(year|yy|yyyy|yr)\b/i],
  ];
  const CARD_TYPES = new Set(["", "text", "tel", "number", "password", "select"]);

  // f: { tag, type, autocomplete, name, id, placeholder, label }. Returns { kind, tagged } or null;
  // `tagged` is true when an autocomplete token said so (heuristic matches need a card number nearby).
  function cardFieldKind(f) {
    if (!f || typeof f !== "object") return null;
    const tag = String(f.tag || "").toLowerCase();
    const type = tag === "select" ? "select" : String(f.type || "").toLowerCase();
    if ((tag !== "input" && tag !== "select") || !CARD_TYPES.has(type)) return null;
    const tokens = String(f.autocomplete || "").toLowerCase().split(/\s+/);
    for (const t of tokens) if (Object.prototype.hasOwnProperty.call(CC_TOKENS, t)) return { kind: CC_TOKENS[t], tagged: true };
    // Fields that say what else they are (a login, an address, a one-time code) are never card fields.
    if (tokens.some((t) => /^(username|email|current-password|new-password|one-time-code|street-address|postal-code|tel)$/.test(t))) return null;
    const hint = [f.name, f.id, f.placeholder, f.label].map((s) => String(s || "").slice(0, 200)).join(" ").replace(/[_-]+/g, " ");
    for (const [kind, re] of CC_HINTS) {
      if (re.test(hint)) return type === "password" && kind !== "csc" ? null : { kind, tagged: false };
    }
    return null;
  }

  // Checks the app's fill_card reply. Returns a fresh { title, name, number, month, year, csc } or null.
  function validCardReply(res) {
    if (!res || typeof res !== "object" || Array.isArray(res) || res.ok !== true) return null;
    const s = (k) => (typeof res[k] === "string" ? res[k] : null);
    const number = s("number"), month = s("exp_month"), year = s("exp_year"), csc = s("csc"), name = s("name");
    if (number === null || !/^\d{12,19}$/.test(number)) return null;
    if (month === null || (month !== "" && !/^(0[1-9]|1[0-2])$/.test(month))) return null;
    if (year === null || (year !== "" && !/^20\d\d$/.test(year)) || !month !== !year) return null;
    if (csc === null || (csc !== "" && !/^\d{3,4}$/.test(csc))) return null;
    if (name === null || name.length > 100) return null;
    const title = typeof res.title === "string" ? res.title.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) : "";
    return { title, name: name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim(), number, month, year, csc };
  }

  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  // The option of a <select> that stands for `want` ("08" / "2027"), as { value } or null.
  // Options: [{ value, text }]. Matches "8", "08", "08 - August", "August", "Aug" for a month;
  // "2027" and "27" for a year.
  function pickOption(kind, want, options) {
    if (!Array.isArray(options) || !want) return null;
    const n = Number(want);
    const matches = (raw) => {
      const v = String(raw || "").trim().toLowerCase();
      if (!v) return false;
      const lead = /^(\d{1,4})\b/.exec(v);
      if (kind === "month") {
        if (lead && lead[1].length <= 2) return Number(lead[1]) === n;
        return v.slice(0, 3) === MONTHS[n - 1];
      }
      if (!lead) return false;
      return lead[1] === want || (lead[1].length === 2 && lead[1] === want.slice(2));
    };
    for (const o of options) if (o && matches(o.value)) return { value: String(o.value) };
    for (const o of options) if (o && matches(o.text)) return { value: String(o.value) };
    return null;
  }

  // The value to put into one card field, or null to leave it alone.
  // card: from validCardReply; field: { tag, maxLength, placeholder, options }.
  function cardFieldValue(kind, card, field) {
    if (!card || !field) return null;
    const select = String(field.tag || "").toLowerCase() === "select";
    const max = typeof field.maxLength === "number" && field.maxLength > 0 ? field.maxLength : 0;
    const ph = String(field.placeholder || "").toLowerCase();
    const fits = (v) => (!max || v.length <= max ? v : null);
    switch (kind) {
      case "number": return select ? null : fits(card.number);
      case "name": return select || !card.name ? null : card.name.slice(0, max || 100);
      case "csc": return select || !card.csc ? null : fits(card.csc);
      case "month": {
        if (!card.month) return null;
        if (select) { const o = pickOption("month", card.month, field.options); return o ? o.value : null; }
        return max === 1 ? null : card.month;
      }
      case "year": {
        if (!card.year) return null;
        if (select) { const o = pickOption("year", card.year, field.options); return o ? o.value : null; }
        return max === 2 || /^\s*(yy|aa|jj)\s*$/.test(ph) ? card.year.slice(2) : card.year;
      }
      case "exp": {
        if (!card.month || !card.year || select) return null;
        const longYear = /(yyyy|aaaa|jjjj)/.test(ph) && !(max && max < 7);
        const yy = longYear ? card.year : card.year.slice(2);
        const sep = / \/ /.test(ph) ? " / " : /-/.test(ph) ? "-" : max === 4 ? "" : "/";
        return fits(`${card.month}${sep}${yy}`) || fits(`${card.month}/${yy}`) || fits(`${card.month}${yy}`);
      }
    }
    return null;
  }

  const api = Object.freeze({
    COLOR_KEYS, CSS_VARS, DEFAULT_THEMES, validateTheme, resolveTheme, applyTheme, themeReplyAction, sameTheme,
    shouldSuggest, suggestPosition, rectsOverlap,
    cardFieldKind, validCardReply, cardFieldValue, pickOption,
  });
  try {
    Object.defineProperty(g, "NotiqShared", { value: api, writable: false, configurable: false, enumerable: false });
  } catch { /* already defined (script injected twice) */ }
})(typeof globalThis !== "undefined" ? globalThis : self);
