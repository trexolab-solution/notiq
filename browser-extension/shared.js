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

  const api = Object.freeze({
    COLOR_KEYS, CSS_VARS, DEFAULT_THEMES, validateTheme, resolveTheme, applyTheme, themeReplyAction, sameTheme,
    shouldSuggest, suggestPosition, rectsOverlap,
  });
  try {
    Object.defineProperty(g, "NotiqShared", { value: api, writable: false, configurable: false, enumerable: false });
  } catch { /* already defined (script injected twice) */ }
})(typeof globalThis !== "undefined" ? globalThis : self);
