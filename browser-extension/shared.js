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

  // ---------- same site (Public Suffix List) ----------
  // The one "same site" rule for frames, the toolbar fill and the multi-step hand-off. Same algorithm as the
  // app's src/lib/publicSuffix.ts, on a copy of its table (refresh: `node browser-extension/build.mjs --psl`).
  // BEGIN PSL (generated from src/lib/publicSuffixData.ts by `node browser-extension/build.mjs --psl`; do not edit by hand)
  const PSL = {
    second: {
      "ac": "com edu gov net mil org",
      "ae": "co net org sch ac gov mil",
      "af": "gov com org net edu",
      "ag": "com org net co nom",
      "al": "com edu gov mil net org",
      "am": "co com commune net org",
      "ao": "ed gv og co pb it",
      "ar": "com edu gob gov int mil net org tur bet coop musica",
      "at": "ac co gv or sth",
      "au": "com net org edu gov asn id csiro act nsw nt qld sa tas vic wa",
      "az": "com net int gov org edu info pp mil name pro biz",
      "ba": "com edu gov mil net org",
      "bb": "biz co com edu gov info net org store tv",
      "bd": "com edu gov net org ac mil",
      "bh": "com edu net org gov",
      "bn": "com edu gov net org",
      "bo": "com edu gob int org net mil tv web",
      "br": "com net org gov edu mil art adv blog eco eng etc far fm fot inf jus leg med mus not odo psi rec slg srv tmp tur tv vet wiki ind ong",
      "bs": "com net org edu gov",
      "bt": "com edu gov net org",
      "bw": "co org",
      "by": "gov mil com of",
      "bz": "com net org edu gov",
      "ca": "ab bc mb nb nf nl ns nt nu on pe qc sk yk gc",
      "cn": "ac com edu gov net org mil ah bj cq fj gd gs gz gx ha hb he hi hl hn jl js jx ln nm nx qh sc sd sh sn sx tj xj xz yn zj hk mo tw",
      "co": "arts com edu firm gov info int mil net nom org rec web",
      "cr": "ac co ed fi go or sa",
      "cu": "com edu org net gov inf",
      "cy": "ac biz com ekloges gov ltd mil net org press pro tm",
      "do": "art com edu gob gov mil net org sld web",
      "dz": "art asso com edu gov org net pol soc tm",
      "ec": "com info net fin k12 med pro org edu gov gob mil",
      "ee": "edu gov riik lib med com pri aip org fie",
      "eg": "com edu eun gov mil name net org sci",
      "es": "com nom org gob edu",
      "et": "com gov org edu biz name info net",
      "fj": "ac biz com gov info mil name net org pro",
      "fr": "asso com gouv nom prd tm",
      "ge": "com edu gov org mil net pvt",
      "gh": "com edu gov org mil",
      "gi": "com ltd gov mod edu org",
      "gr": "com edu net org gov",
      "gt": "com edu gob ind mil net org",
      "gy": "co com edu gov net org",
      "hk": "com edu gov idv net org",
      "hn": "com edu org net mil gob",
      "hr": "iz from name com",
      "ht": "com shop firm info adult net pro org med art coop pol asso edu rel gouv perso",
      "hu": "co info org priv sport tm agrar bolt casino city erotica film forum games hotel ingatlan jogasz konyvelo lakas media news reklam sex shop suli szex tozsde utazas video",
      "id": "ac biz co desa go mil my net or ponpes sch web",
      "ie": "gov",
      "il": "ac co gov idf k12 muni net org",
      "in": "co firm net org gen ind nic ac edu res gov mil biz info",
      "iq": "gov edu mil com org net",
      "ir": "ac co gov id net org sch",
      "it": "gov edu",
      "je": "co net org",
      "jm": "com net org edu gov mil",
      "jo": "com org net edu sch gov mil name",
      "jp": "ac ad co ed go gr lg ne or",
      "ke": "ac co go info me mobi ne or sc",
      "kg": "org net com edu gov mil",
      "kh": "com edu gov mil net org per",
      "kr": "ac co es go hs kg mil ms ne or pe re sc",
      "kw": "com edu emb gov ind net org",
      "kz": "org edu net gov mil com",
      "lb": "com edu gov net org",
      "lk": "gov sch net int com org edu ngo soc web ltd assn grp hotel ac",
      "lr": "com edu gov org net",
      "ls": "ac biz co edu gov info net org sc",
      "lv": "com edu gov org mil id net asn conf",
      "ly": "com net gov plc edu sch med org id",
      "ma": "co net gov org ac press",
      "mk": "com org net edu gov inf name",
      "mm": "com edu gov net org",
      "mn": "gov edu org",
      "mo": "com net org edu gov",
      "mt": "com edu net org",
      "mu": "com net org gov ac co or",
      "mv": "aero biz com coop edu gov info int mil museum name net org pro",
      "mw": "ac biz co com coop edu gov int museum net org",
      "mx": "com org gob edu net",
      "my": "biz com edu gov mil name net org",
      "mz": "ac adv co edu gov mil net org",
      "na": "info pro name school or dr us mx ca in cc tv ws mobi co com org",
      "ng": "com edu gov i mil mobi name net org sch",
      "ni": "ac biz co com edu gob in info int mil net nom org web",
      "np": "com edu gov org mil net",
      "nz": "ac co cri geek gen govt health iwi kiwi maori mil net org parliament school",
      "om": "co com edu gov med museum net org pro",
      "pa": "ac gob com org sld edu net ing abo med nom",
      "pe": "edu gob nom mil org com net",
      "pg": "com net org gov mil ac",
      "ph": "com net org gov edu ngo mil i",
      "pk": "com net edu org fam biz web gov gob gok gon gop gos info",
      "pl": "com net org aid agro atm auto biz edu gmina gsm info mail miasta media mil nieruchomosci nom pc powiat priv realestate rel sex shop sklep sos szkola targi tm tourism travel turystyka gov",
      "pr": "com net org gov edu isla pro biz info name est prof ac",
      "ps": "edu gov sec plo com org net",
      "pt": "net gov org edu int publ com nome",
      "py": "com coop edu gov mil net org",
      "qa": "com edu gov mil name net org sch",
      "ro": "arts com firm info nom nt org rec store tm www",
      "rs": "ac co edu gov in org",
      "ru": "ac edu gov int mil test",
      "rw": "ac co coop gov mil net org",
      "sa": "com net org gov med pub edu sch",
      "sb": "com edu gov net org",
      "sc": "com gov net org edu",
      "sd": "com net org edu med tv gov info",
      "sg": "com net org gov edu per",
      "sl": "com net edu gov org",
      "sn": "art com edu gouv org perso univ",
      "sv": "com edu gob org red",
      "sy": "edu gov net mil com org",
      "th": "ac co go in mi net or",
      "tj": "ac biz co com edu go gov int mil name net nic org test web",
      "tn": "com ens fin gov ind info intl mincom nat net org perso tourism",
      "tr": "av bbs bel biz com dr edu gen gov info mil k12 kep name net org pol tel tsk tv web nc",
      "tt": "co com org net biz info pro int coop jobs mobi travel museum aero name gov edu",
      "tw": "edu gov mil com net org idv game ebiz club",
      "tz": "ac co go hotel info me mil mobi ne or sc tv",
      "ua": "com edu gov in net org kiev kyiv lviv odessa kharkov dnepropetrovsk",
      "ug": "co or ac sc go ne com org",
      "uk": "ac co gov ltd me net nhs org plc police sch",
      "us": "dni fed isa kids nsn ak al ar as az ca co ct dc de fl ga gu hi ia id il in ks ky la ma md me mi mn mo ms mt nc nd ne nh nj nm nv ny oh ok or pa pr ri sc sd tn tx ut vi vt va wa wi wv wy",
      "uy": "com edu gub mil net org",
      "uz": "co com net org",
      "ve": "arts bib co com e12 edu firm gob gov info int mil net nom org rar rec store tec web",
      "vn": "com net org edu gov int ac biz info name pro health",
      "ws": "com net org gov edu",
      "za": "ac agric alt co edu gov grondar law mil net ngo nic nis nom org school tm web",
      "zm": "ac biz co com edu gov info mil net org sch",
      "zw": "ac co gov mil org",
    },
    extra: ["nsw.edu.au","vic.edu.au","qld.edu.au","gov.au","k12.ca.us","k12.ny.us","k12.tx.us","blogspot.co.uk","github.io","githubusercontent.com","gitlab.io","bitbucket.io","herokuapp.com","herokussl.com","vercel.app","now.sh","netlify.app","netlify.com","pages.dev","workers.dev","web.app","firebaseapp.com","appspot.com","blogspot.com","wordpress.com","tumblr.com","azurewebsites.net","azurestaticapps.net","cloudapp.net","cloudfront.net","s3.amazonaws.com","elasticbeanstalk.com","onrender.com","fly.dev","glitch.me","repl.co","replit.app","surge.sh","ngrok.io","ngrok-free.app","duckdns.org","no-ip.org","dyndns.org","myshopify.com","wixsite.com","squarespace.com","webflow.io","readthedocs.io"],
    wildcard: ["bd","ck","er","fk","jm","kh","mm","np","pg","kawasaki.jp","kitakyushu.jp","kobe.jp","nagoya.jp","sapporo.jp","sendai.jp","yokohama.jp","compute.amazonaws.com"],
    exception: ["www.ck","city.kawasaki.jp","city.kitakyushu.jp","city.kobe.jp","city.nagoya.jp","city.sapporo.jp","city.sendai.jp","city.yokohama.jp"],
  };
  // END PSL
  let pslRules = null;
  const pslWild = new Set(PSL.wildcard);
  const pslExcept = new Set(PSL.exception);
  function ruleSet() {
    if (pslRules) return pslRules;
    pslRules = new Set(PSL.extra);
    for (const tld of Object.keys(PSL.second)) for (const l of PSL.second[tld].split(" ")) if (l) pslRules.add(`${l}.${tld}`);
    return pslRules;
  }

  // Lower-case, no trailing dot, no IPv6 brackets, no port.
  function normalizeHost(host) {
    let h = String(host || "").trim().toLowerCase();
    if (h.startsWith("[")) {
      const end = h.indexOf("]");
      return end > 0 ? h.slice(1, end) : h.slice(1);
    }
    if ((h.match(/:/g) || []).length === 1) h = h.slice(0, h.indexOf(":"));
    return h.replace(/\.+$/, "");
  }
  // Any IPv6 address, and any all-digits-and-dots name (stricter than a.b.c.d on purpose).
  const isIpHost = (host) => { const h = normalizeHost(host); return h.includes(":") || /^[\d.]+$/.test(h); };
  const isLocalhost = (host) => /(^|\.)localhost$/.test(normalizeHost(host));
  function isRule(name) {
    if (!name || pslExcept.has(name)) return false;
    if (!name.includes(".")) return true; // every TLD (the PSL's default `*` rule)
    if (ruleSet().has(name)) return true;
    return pslWild.has(name.slice(name.indexOf(".") + 1));
  }
  // `www.bbc.co.uk` -> `co.uk`; "" for an empty host or an IP address.
  function publicSuffix(host) {
    const h = normalizeHost(host);
    if (!h || isIpHost(h)) return "";
    const labels = h.split(".");
    for (let i = 0; i < labels.length; i++) {
      const cand = labels.slice(i).join(".");
      if (pslExcept.has(cand)) return cand.slice(cand.indexOf(".") + 1);
      if (isRule(cand)) return cand;
    }
    return labels[labels.length - 1];
  }
  // `login.bbc.co.uk` -> `bbc.co.uk`; null for an IP, localhost, an empty host or a public suffix itself.
  function registrableDomain(host) {
    const h = normalizeHost(host);
    if (!h || isIpHost(h) || isLocalhost(h)) return null;
    const suffix = publicSuffix(h);
    if (suffix === h) return null;
    const label = h.slice(0, h.length - suffix.length - 1).split(".").pop();
    return label ? `${label}.${suffix}` : null;
  }
  // Is `host` on the same site as the top page `top`? The exact host always is; otherwise both must be under
  // the top host's registrable domain. IPs and localhost only match themselves; a top host that is itself a
  // public suffix (or a github.io-style tenant's sibling) never matches anything else.
  function sameSite(host, top) {
    const h = normalizeHost(host), t = normalizeHost(top);
    if (!h || !t) return false;
    if (h === t) return true;
    if (isIpHost(h) || isIpHost(t) || isLocalhost(h) || isLocalhost(t)) return false;
    const site = registrableDomain(t);
    return !!site && (h === site || h.endsWith(`.${site}`));
  }

  // The https-or-localhost rule for a URL / origin: { host, origin } or null.
  function secureOrigin(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { return null; }
    const host = u.hostname.toLowerCase();
    if (!host) return null;
    if (u.protocol !== "https:" && !(u.protocol === "http:" && (host === "localhost" || host === "127.0.0.1"))) return null;
    return { host, origin: u.origin };
  }

  // Toolbar fill, phase 1: may the credentials go to a frame, given its secret-free probe result
  // ({ origin, top, ancestors, fields }), its frameId and the tab's top origin? The top frame must be the
  // tab's own origin; a subframe must be secure, same-site with the top host, and so must every ancestor,
  // the outermost ancestor being the top origin itself. Frames without fillable fields never qualify.
  function fillTargetOk(probe, frameId, topOrigin) {
    if (!probe || typeof probe !== "object" || probe.fields !== true || typeof frameId !== "number") return false;
    const top = secureOrigin(topOrigin);
    const me = secureOrigin(probe.origin);
    if (!top || !me || me.origin !== probe.origin) return false;
    if (frameId === 0) return probe.top === true && me.origin === top.origin;
    if (probe.top !== false || !sameSite(me.host, top.host)) return false;
    const ao = probe.ancestors;
    if (!Array.isArray(ao) || !ao.length || ao.length > 32) return false;
    for (const a of ao) {
      const o = secureOrigin(a);
      if (!o || o.origin !== a || !sameSite(o.host, top.host)) return false;
    }
    return ao[ao.length - 1] === top.origin;
  }

  // ---------- app <-> extension handshake ----------
  // PROTOCOL is this extension's message protocol; the app has its own (autofill.rs `PROTOCOL`).
  // Compatible when appProtocol >= MIN_APP_PROTOCOL and PROTOCOL >= the app's `minProtocol`.
  // An app whose ping reply has no `protocol` is protocol 1 (and accepts every extension).
  //   1: the original messages.  2: ping -> { ok, appVersion, locked, protocol, minProtocol }; every request
  //      carries { ext: <extension version>, protocol }; the app may answer { error: "extension_outdated" }.
  const PROTOCOL = 2;
  const MIN_APP_PROTOCOL = 1;
  // First Notiq release that speaks each protocol (for "Update Notiq" messages).
  const APP_VERSION_FOR_PROTOCOL = Object.freeze({ 1: "0.7.0", 2: "0.9.0" });
  const posInt = (v) => (Number.isInteger(v) && v > 0 && v < 1e6 ? v : null);
  const shortVer = (v) => (typeof v === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(v) ? v : "");

  // What a ping reply means for the user:
  //   { state: "on" | "locked" | "off" | "update_app" | "update_ext", text, detail, appVersion }.
  function appStatus(res, extVersion) {
    const ext = shortVer(extVersion);
    if (!res || typeof res !== "object" || Array.isArray(res)) return { state: "off", text: "Notiq not running", detail: "", appVersion: "" };
    const appVersion = shortVer(res.appVersion);
    const appName = appVersion ? `Notiq ${appVersion}` : "This version of Notiq";
    const extName = ext ? `v${ext}` : "this version";
    const updateExt = { state: "update_ext", text: "Update the extension", appVersion,
      detail: `${appName} needs a newer Notiq Autofill extension (you have ${extName}). Update it from your browser's extension store or the Notiq release page.` };
    if (res.error === "extension_outdated") return updateExt;
    if (res.ok !== true) return { state: "off", text: "Notiq not running", detail: "", appVersion: "" };
    const appProtocol = posInt(res.protocol) || 1;
    const appMin = posInt(res.minProtocol) || 1;
    if (appMin > PROTOCOL) return updateExt;
    if (appProtocol < MIN_APP_PROTOCOL) {
      const need = APP_VERSION_FOR_PROTOCOL[MIN_APP_PROTOCOL] || "a newer version";
      return { state: "update_app", text: "Update Notiq", appVersion,
        detail: `This extension (${extName}) needs Notiq ${need} or newer${appVersion ? `; you have ${appVersion}` : ""}. Update Notiq from its Settings or the release page.` };
    }
    if (res.locked === true) return { state: "locked", text: "Notiq is locked", appVersion,
      detail: "Your vault is locked. Unlock it in Notiq to fill or save logins." };
    return { state: "on", text: "Notiq running", detail: appVersion ? `Notiq ${appVersion}` : "", appVersion };
  }

  const api = Object.freeze({
    COLOR_KEYS, CSS_VARS, DEFAULT_THEMES, validateTheme, resolveTheme, applyTheme, themeReplyAction, sameTheme,
    shouldSuggest, suggestPosition, rectsOverlap,
    cardFieldKind, validCardReply, cardFieldValue, pickOption,
    normalizeHost, publicSuffix, registrableDomain, sameSite, secureOrigin, fillTargetOk,
    PROTOCOL, MIN_APP_PROTOCOL, APP_VERSION_FOR_PROTOCOL, appStatus,
  });
  try {
    Object.defineProperty(g, "NotiqShared", { value: api, writable: false, configurable: false, enumerable: false });
  } catch { /* already defined (script injected twice) */ }
})(typeof globalThis !== "undefined" ? globalThis : self);
