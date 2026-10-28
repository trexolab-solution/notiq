/* Notiq landing page: live components. Vanilla JS, no network requests. */
(function () {
  "use strict";

  var doc = document, root = doc.documentElement;
  var reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  var reduce = reduceMQ.matches;
  var $ = function (s, c) { return (c || doc).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); };
  var esc = function (t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
  var icon = function (id, cls) { return '<svg class="i' + (cls ? " " + cls : "") + '" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; };
  var HEX = "0123456789abcdef";
  var rnd = function (n) { return Math.random() * n | 0; };

  /* ── Secure random (password generator, sample keys) ─────── */
  function randInt(max) { // unbiased 0..max-1
    var lim = Math.floor(0x100000000 / max) * max, buf = new Uint32Array(1);
    do { crypto.getRandomValues(buf); } while (buf[0] >= lim);
    return buf[0] % max;
  }
  function randBytes(n) { var b = new Uint8Array(n); crypto.getRandomValues(b); return b; }

  /* ── Theme toggle ────────────────────────────────────────── */
  var toggle = $("#themeToggle");
  function currentTheme() {
    var t = root.getAttribute("data-theme");
    if (t) return t;
    return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function syncToggle() {
    var t = currentTheme();
    toggle.setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }
  toggle.addEventListener("click", function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("notiq-site-theme", next); } catch (e) { /* storage blocked */ }
    syncToggle();
  });
  syncToggle();

  /* ── Header state ────────────────────────────────────────── */
  var head = $(".site-head");
  var onScroll = function () { head.classList.toggle("is-scrolled", scrollY > 8); };
  addEventListener("scroll", onScroll, { passive: true }); onScroll();

  /* ── OS detection for the primary download ──────────────── */
  (function () {
    var p = "";
    try { p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ""; } catch (e) { /* ignore */ }
    var ua = navigator.userAgent || "";
    var s = (p + " " + ua).toLowerCase();
    var os = null;
    if (/android|iphone|ipad|ipod/.test(s)) os = "mobile";
    else if (/win/.test(s)) os = "windows";
    else if (/mac/.test(s)) os = "macos";
    else if (/linux|x11|cros/.test(s)) os = "linux";
    var names = { windows: "Windows", macos: "macOS", linux: "Linux" };
    if (names[os]) {
      $("#heroDownloadLabel").textContent = "Download for " + names[os];
      var card = $('.os[data-os="' + os + '"]');
      if (card) card.classList.add("is-you");
    } else if (os === "mobile") {
      $("#heroDownload").setAttribute("href", "#download");
      $("#heroDownloadLabel").textContent = "Get it for your desktop";
    }
  })();

  /* ── Scroll reveal with stagger ─────────────────────────── */
  if (!reduce && "IntersectionObserver" in window) {
    var revealIO = new IntersectionObserver(function (entries) {
      var shown = entries.filter(function (e) { return e.isIntersecting; }).map(function (e) { return e.target; });
      shown.forEach(function (el, i) {
        el.style.setProperty("--d", Math.min(i, 6) * 90 + "ms");
        el.classList.add("in");
        revealIO.unobserve(el);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    $$(".reveal").forEach(function (el) { revealIO.observe(el); });
  } else {
    $$(".reveal").forEach(function (el) { el.classList.add("in"); });
  }

  /* ── Visibility gating: demos run only on screen and in a visible tab ── */
  var watched = [];
  var gateIO = "IntersectionObserver" in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      watched.forEach(function (w) { if (w.el === e.target) { w.inView = e.isIntersecting; w.update(); } });
    });
  }, { threshold: 0.08 }) : null;
  function player(el, onChange) {
    var w = {
      el: el, inView: !gateIO, active: false, waiters: [],
      update: function () {
        var a = w.inView && !doc.hidden;
        if (a === w.active) return;
        w.active = a;
        if (onChange) onChange(a);
        if (a) { var ws = w.waiters; w.waiters = []; ws.forEach(function (r) { r(); }); }
      },
      gate: function () { return w.active ? Promise.resolve() : new Promise(function (r) { w.waiters.push(r); }); },
      sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }).then(w.gate); }
    };
    watched.push(w);
    if (gateIO) gateIO.observe(el);
    w.update();
    return w;
  }
  doc.addEventListener("visibilitychange", function () { watched.forEach(function (w) { w.update(); }); });

  /* ── Mini Markdown: highlighter + renderer ──────────────── */
  function inlineMd(t) {
    return esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">$1</span>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="wikilink">$1</span>');
  }
  function renderMd(src) {
    var out = [], list = false;
    var close = function () { if (list) { out.push("</ul>"); list = false; } };
    src.split("\n").forEach(function (line) {
      var m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { close(); out.push('<div class="' + (m[1].length === 1 ? "md-h1" : "md-h2") + '">' + inlineMd(m[2]) + "</div>"); }
      else if ((m = /^\s*[-*]\s+\[( |x|X)\]\s?(.*)$/.exec(line))) {
        if (!list) { out.push("<ul>"); list = true; }
        var on = m[1] !== " ";
        out.push('<li class="task' + (on ? " done" : "") + '"><span class="box' + (on ? " on" : "") + '"></span><span>' + inlineMd(m[2]) + "</span></li>");
      }
      else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { if (!list) { out.push("<ul>"); list = true; } out.push("<li>" + inlineMd(m[1]) + "</li>"); }
      else if ((m = /^>\s?(.*)$/.exec(line))) { close(); out.push("<blockquote>" + inlineMd(m[1]) + "</blockquote>"); }
      else if (!line.trim()) { close(); }
      else { close(); out.push("<p>" + inlineMd(line) + "</p>"); }
    });
    close();
    return out.join("");
  }
  function hlLine(line) {
    var m;
    if ((m = /^(#{1,6}\s.*)$/.exec(line))) return '<span class="md-h">' + esc(m[1]) + "</span>";
    var pre = "", rest = line;
    if ((m = /^(\s*[-*]\s)(\[[ xX]\]\s?)?(.*)$/.exec(line))) {
      pre = '<span class="md-li">' + esc(m[1]) + "</span>" + (m[2] ? '<span class="md-k">' + esc(m[2]) + "</span>" : "");
      rest = m[3];
    } else if ((m = /^(>\s?)(.*)$/.exec(line))) {
      pre = '<span class="md-q">' + esc(m[1]) + "</span>"; rest = m[2];
    }
    var body = esc(rest)
      .replace(/(`[^`]+`)/g, '<span class="md-c">$1</span>')
      .replace(/(\*\*[^*]+\*\*)/g, '<span class="md-b">$1</span>')
      .replace(/(\[\[[^\]]+\]\])/g, '<span class="md-wl">$1</span>');
    return pre + body;
  }
  function hlMd(src) { return src.split("\n").map(hlLine).join("\n"); }
  function words(t) { var m = t.replace(/[#*`>\[\]\-]/g, " ").match(/\S+/g); return m ? m.length : 0; }

  /* ── Hero: write → preview → lock → sealed, looping ──────── */
  (function () {
    var win = $("#heroWin"), stage = $("#heroStage"), hero = $(".hero");
    var src = $("#heroSrc"), prev = $("#heroPrev"), hex = $("#heroHex");
    var tabIcon = $("#heroTabIcon use"), vaultIcon = $("#heroVaultIcon use");
    var status = $("#heroStatus"), wordsEl = $("#heroWords");
    var NOTE = "# Prod server\nDeploy with **zero downtime**.\n\n- host: prod-1.example.com\n- user: deploy\n- [[Runbook]] for rollbacks";
    var hexLines = function (rows) {
      var l = [];
      for (var r = 0; r < rows; r++) { var b = []; for (var i = 0; i < 12; i++) b.push(HEX[rnd(16)] + HEX[rnd(16)]); l.push(b.join(" ")); }
      return l.join("\n");
    };
    hex.textContent = hexLines(4);

    if (reduce) return; // static: the written note is already in the markup

    // pointer tilt + cursor glow (fine pointers only)
    if (matchMedia("(pointer: fine)").matches) {
      var glow = $(".hero-glow"), raf = 0, px = 0, py = 0;
      hero.addEventListener("pointermove", function (e) {
        px = e.clientX; py = e.clientY;
        if (!raf) raf = requestAnimationFrame(function () {
          raf = 0;
          var hr = hero.getBoundingClientRect();
          glow.style.transform = "translate3d(" + (px - hr.left) + "px," + (py - hr.top) + "px,0)";
          var r = stage.getBoundingClientRect();
          var dx = (px - (r.left + r.width / 2)) / r.width, dy = (py - (r.top + r.height / 2)) / r.height;
          dx = Math.max(-1, Math.min(1, dx)); dy = Math.max(-1, Math.min(1, dy));
          win.style.transform = "rotateY(" + (dx * 5).toFixed(2) + "deg) rotateX(" + (-dy * 4).toFixed(2) + "deg)";
        });
        hero.classList.add("has-pointer");
      });
      hero.addEventListener("pointerleave", function () { hero.classList.remove("has-pointer"); win.style.transform = ""; });
    }

    var p = player(win);
    function scrambleText(text, k) { // replace a growing share of glyphs with hex
      var out = "";
      for (var i = 0; i < text.length; i++) {
        var c = text[i];
        out += (c === "\n" || c === " " || Math.random() > k) ? c : HEX[rnd(16)];
      }
      return out;
    }
    async function loop() {
      for (;;) {
        // reset
        win.classList.remove("is-sealed", "is-scramble", "is-press");
        tabIcon.setAttribute("href", "#i-note"); vaultIcon.setAttribute("href", "#i-lock-open");
        status.textContent = "Markdown";
        src.innerHTML = '<i class="caret"></i>'; prev.innerHTML = ""; wordsEl.textContent = "0 words";
        await p.sleep(700);
        // type
        for (var i = 1; i <= NOTE.length; i++) {
          var part = NOTE.slice(0, i);
          src.innerHTML = hlMd(part) + '<i class="caret"></i>';
          if (NOTE[i - 1] === " " || NOTE[i - 1] === "\n" || i === NOTE.length) {
            prev.innerHTML = renderMd(part); wordsEl.textContent = words(part) + " words";
          }
          var ch = NOTE[i - 1];
          await p.sleep(ch === "\n" ? 260 : 26 + rnd(40));
        }
        src.innerHTML = hlMd(NOTE);
        await p.sleep(1300);
        // lock
        win.classList.add("is-press"); status.textContent = "Locking…";
        await p.sleep(320);
        win.classList.remove("is-press");
        tabIcon.setAttribute("href", "#i-lock");
        win.classList.add("is-scramble");
        var nodes = [], walker = doc.createTreeWalker(prev, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) nodes.push([walker.currentNode, walker.currentNode.data]);
        for (var k = 1; k <= 14; k++) {
          src.textContent = scrambleText(NOTE, k / 14);
          nodes.forEach(function (n) { n[0].data = scrambleText(n[1], k / 14); });
          await p.sleep(55);
        }
        win.classList.add("is-sealed"); vaultIcon.setAttribute("href", "#i-lock");
        status.textContent = "Saved to vault.nqdb";
        for (var t = 0; t < 22; t++) { hex.textContent = hexLines(4); await p.sleep(120); }
        await p.sleep(1600);
      }
    }
    loop();
  })();

  /* ── Editor demo ─────────────────────────────────────────── */
  (function () {
    var panes = $("#edPanes"), ta = $("#edInput"), hl = $("#edHl"), prev = $("#edPrev"), gutter = $("#edGutter");
    var wordsEl = $("#edWords"), linesEl = $("#edLines");
    var srcPane = $(".ed-src", panes);
    function render() {
      var v = ta.value;
      hl.innerHTML = hlMd(v) + "\n";
      prev.innerHTML = renderMd(v);
      var n = v.split("\n").length, cur = v.slice(0, ta.selectionStart).split("\n").length, g = "";
      for (var i = 1; i <= n; i++) g += "<span" + (i === cur ? ' class="cur"' : "") + ">" + i + "</span>";
      gutter.innerHTML = g;
      wordsEl.textContent = words(v) + " words";
      linesEl.textContent = "Ln " + cur;
      syncScroll();
    }
    function syncScroll() { hl.scrollTop = ta.scrollTop; gutter.scrollTop = ta.scrollTop; }
    ta.addEventListener("input", render);
    ta.addEventListener("scroll", syncScroll);
    ["keyup", "click"].forEach(function (ev) { ta.addEventListener(ev, render); });
    $$(".toolbar .seg button").forEach(function (b) {
      b.addEventListener("click", function () {
        var v = b.getAttribute("data-view");
        panes.setAttribute("data-view", v);
        $$(".toolbar .seg button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        srcPane.inert = v === "preview"; prev.inert = v === "source";
        if (v === "source") prev.removeAttribute("tabindex"); else prev.setAttribute("tabindex", "0");
      });
    });
    render();
  })();

  /* ── Vault explorer ──────────────────────────────────────── */
  (function () {
    var KIND = { folder: "Folder", note: "Secure note", login: "Login", ssh: "SSH / server", secret: "API key / secret" };
    var ICON = { folder: "folder", note: "note", login: "login", ssh: "ssh", secret: "secret" };
    var uid = 100;
    var items = [
      { id: 1, name: "Servers", kind: "folder", parent: null, tags: [] },
      { id: 2, name: "Production VPS", kind: "ssh", parent: 1, tags: ["prod", "linux"], starred: true },
      { id: 3, name: "Staging box", kind: "ssh", parent: 1, tags: ["staging", "linux"] },
      { id: 4, name: "Logins", kind: "folder", parent: null, tags: [] },
      { id: 5, name: "GitHub", kind: "login", parent: 4, tags: ["work", "2fa"], starred: true },
      { id: 6, name: "Bank portal", kind: "login", parent: 4, tags: ["finance", "2fa"] },
      { id: 7, name: "Work", kind: "folder", parent: 4, tags: [] },
      { id: 8, name: "Jira", kind: "login", parent: 7, tags: ["work"] },
      { id: 9, name: "API keys", kind: "folder", parent: null, tags: [] },
      { id: 10, name: "OpenRouter", kind: "secret", parent: 9, tags: ["ai"] },
      { id: 11, name: "Stripe test key", kind: "secret", parent: 9, tags: ["work"] },
      { id: 12, name: "Recovery codes", kind: "note", parent: null, tags: ["2fa"] },
      { id: 13, name: "Home Wi-Fi", kind: "note", parent: null, tags: ["home"] }
    ];
    var trash = [{ id: 20, name: "Old router admin", kind: "login", parent: null, tags: ["home"], days: 3 }];
    var expanded = { 1: true, 4: true, 7: false, 9: false };
    var selected = 2, tagFilter = [], query = "", showTrash = false, renaming = null, dragId = null, fresh = null;

    var tree = $("#vxTree"), tagsEl = $("#vxTags"), detail = $("#vxDetail"), trashEl = $("#vxTrash");
    var bin = $("#vxBin"), binCount = $("#vxBinCount"), search = $("#vxSearch"), announce = $("#vxAnnounce");
    var lockedEl = $("#vxLocked"), lockBtn = $("#vxLock"), unlockBtn = $("#vxUnlock");

    var byId = function (id) { for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i]; return null; };
    var children = function (pid) {
      return items.filter(function (x) { return x.parent === pid; }).sort(function (a, b) {
        if ((a.kind === "folder") !== (b.kind === "folder")) return a.kind === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    };
    var path = function (it) { var p = [], c = it.parent != null ? byId(it.parent) : null; while (c) { p.unshift(c.name); c = c.parent != null ? byId(c.parent) : null; } return p.join(" / "); };
    var isInside = function (id, folderId) { var c = byId(folderId); while (c) { if (c.id === id) return true; c = c.parent != null ? byId(c.parent) : null; } return false; };
    var say = function (t) { announce.textContent = ""; setTimeout(function () { announce.textContent = t; }, 30); };

    function matches(it) {
      if (it.kind === "folder") return false;
      if (tagFilter.length && !tagFilter.every(function (t) { return it.tags.indexOf(t) >= 0; })) return false;
      if (query) {
        var q = query.toLowerCase();
        if (it.name.toLowerCase().indexOf(q) < 0 && !it.tags.some(function (t) { return t.toLowerCase().indexOf(q) >= 0; })) return false;
      }
      return true;
    }

    function rowHtml(it, depth, opts) {
      var dir = it.kind === "folder", open = dir && expanded[it.id];
      var cls = "vt-row" + (it.id === selected ? " is-sel" : "") + (it.id === fresh ? " is-new" : "");
      var name = renaming === it.id
        ? '<input class="vt-input" data-rename="' + it.id + '" value="' + esc(it.name) + '" aria-label="New name for ' + esc(it.name) + '">'
        : '<span class="vt-name">' + esc(it.name) + (opts && opts.where ? ' <span class="vt-where">· ' + esc(opts.where) + "</span>" : "") + "</span>";
      var tags = it.tags.slice(0, 2).map(function (t) { return '<span class="vt-tag">' + esc(t) + "</span>"; }).join("") + (it.tags.length > 2 ? '<span class="vt-tag">+' + (it.tags.length - 2) + "</span>" : "");
      var main = renaming === it.id
        ? '<span class="vt-main"><span class="vt-chev"></span>' + icon(dir ? (open ? "folder-open" : "folder") : ICON[it.kind], "k-" + it.kind) + name + "</span>"
        : '<button type="button" class="vt-main" data-sel="' + it.id + '"' + (dir ? ' aria-expanded="' + !!open + '"' : "") +
          ' aria-label="' + esc(it.name) + ", " + KIND[it.kind] + (it.starred ? ", starred" : "") + (it.tags.length ? ", tags " + esc(it.tags.join(", ")) : "") + '">' +
          '<span class="vt-chev">' + (dir ? icon("chevron") : "") + "</span>" +
          icon(dir ? (open ? "folder-open" : "folder") : ICON[it.kind], "k-" + it.kind) + name +
          (tags ? '<span class="vt-tags" aria-hidden="true">' + tags + "</span>" : "") + "</button>";
      var acts = dir ? "" :
        '<button type="button" class="vt-act vt-star" data-star="' + it.id + '" aria-pressed="' + !!it.starred + '" aria-label="' + (it.starred ? "Unstar " : "Star ") + esc(it.name) + '">' + icon("star") + "</button>" +
        '<button type="button" class="vt-act" data-del="' + it.id + '" aria-label="Move ' + esc(it.name) + ' to Recycle Bin">' + icon("trash") + "</button>";
      return '<div class="' + cls + '" data-id="' + it.id + '" draggable="' + (renaming === it.id ? "false" : "true") + '" style="padding-left:' + (2 + depth * 14) + 'px">' + main + acts + "</div>";
    }
    function branch(pid, depth) {
      return children(pid).map(function (it) {
        var sub = it.kind === "folder" && expanded[it.id] ? branch(it.id, depth + 1) : "";
        return "<li>" + rowHtml(it, depth) + (sub ? "<ul>" + sub + "</ul>" : "") + "</li>";
      }).join("");
    }

    function renderTags() {
      var counts = {};
      items.forEach(function (it) { it.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; }); });
      var html = Object.keys(counts).sort().map(function (t) {
        var on = tagFilter.indexOf(t) >= 0;
        return '<button type="button" class="vt-chip" data-tag="' + esc(t) + '" aria-pressed="' + on + '" aria-label="' + (on ? "Remove filter " : "Show only ") + esc(t) + ", " + counts[t] + ' items">' + icon("hash") + "<span>" + esc(t) + '</span><span class="n">' + counts[t] + "</span></button>";
      }).join("");
      if (tagFilter.length) html += '<button type="button" class="vt-chip" data-clear>' + icon("x") + "Clear</button>";
      tagsEl.innerHTML = html;
    }

    function renderTree() {
      if (showTrash) {
        tree.hidden = true; trashEl.hidden = false;
        trashEl.innerHTML = '<div class="vx-group">Recycle Bin</div>' + (trash.length ? "<ul>" + trash.map(function (it) {
          return '<li class="tr-row">' + icon(ICON[it.kind], "k-" + it.kind) + '<span class="tr-meta"><b>' + esc(it.name) + "</b><span>Deleted " + (it.days ? it.days + " days ago" : "just now") + " · purged in " + (30 - (it.days || 0)) + " days</span></span>" +
            '<button type="button" class="tr-btn" data-restore="' + it.id + '" aria-label="Restore ' + esc(it.name) + '">' + icon("restore") + "Restore</button>" +
            '<button type="button" class="tr-btn danger" data-purge="' + it.id + '" aria-label="Delete ' + esc(it.name) + ' forever">Delete forever</button></li>';
        }).join("") + "</ul>" : '<p class="vx-empty">The Recycle Bin is empty.</p>') +
          '<p class="tr-note">Items here are deleted for good after 30 days.</p>';
        return;
      }
      tree.hidden = false; trashEl.hidden = true;
      var html = "";
      if (query || tagFilter.length) {
        var hits = items.filter(matches);
        html = '<div class="vx-group">' + hits.length + (hits.length === 1 ? " match" : " matches") + "</div>" +
          (hits.length ? "<ul>" + hits.map(function (it) { return "<li>" + rowHtml(it, 0, { where: path(it) }) + "</li>"; }).join("") + "</ul>" : '<p class="vx-empty">Nothing matches. Try another name or tag.</p>');
      } else {
        var starred = items.filter(function (x) { return x.starred; });
        if (starred.length) html += '<div class="vx-group">Starred</div><ul>' + starred.map(function (it) { return "<li>" + rowHtml(it, 0, { where: path(it) }) + "</li>"; }).join("") + "</ul>";
        html += '<div class="vx-group">All items</div><ul class="vx-root">' + branch(null, 0) + "</ul>";
      }
      tree.innerHTML = html;
      fresh = null;
      var inp = $("[data-rename]", tree);
      if (inp) { inp.focus(); inp.select(); }
    }

    function renderDetail() {
      var it = byId(selected);
      if (!it || showTrash) {
        detail.innerHTML = '<div class="vd-empty">' + icon("lock-open") + "<span>" + (showTrash ? "Restore an item, or delete it forever." : "Select an item to see its details.") + "</span></div>";
        return;
      }
      var dir = it.kind === "folder";
      var folders = items.filter(function (f) { return f.kind === "folder" && f.id !== it.id && !isInside(it.id, f.id); });
      var opts = '<option value="">Vault root</option>' + folders.map(function (f) { var p = path(f); return '<option value="' + f.id + '"' + (it.parent === f.id ? " selected" : "") + ">" + esc((p ? p + " / " : "") + f.name) + "</option>"; }).join("");
      detail.innerHTML =
        '<div class="vd-head">' + icon(dir ? "folder-open" : ICON[it.kind], "k-" + it.kind) + '<div class="vd-name">' + esc(it.name) + "</div>" +
        (dir ? "" : '<button type="button" class="vx-icon vt-star" data-star="' + it.id + '" aria-pressed="' + !!it.starred + '" aria-label="' + (it.starred ? "Unstar" : "Star") + '">' + icon("star") + "</button>") + "</div>" +
        '<p class="vd-sub">' + KIND[it.kind] + "</p>" +
        '<dl class="vd-grid"><dt>Location</dt><dd>' + esc(path(it) || "Vault root") + "</dd>" +
        (dir ? "<dt>Contains</dt><dd>" + children(it.id).length + " items</dd>"
             : "<dt>Tags</dt><dd>" + (it.tags.length ? it.tags.map(function (t) { return '<span class="vt-tag">' + esc(t) + "</span>"; }).join("") : "None") + "</dd>" +
               '<dt>Contents</dt><dd><span class="vd-mask">••••••••••••••</span></dd>') +
        "<dt>On disk</dt><dd>Inside vault.nqdb</dd></dl>" +
        '<div class="vd-actions">' +
        '<button type="button" class="vd-btn" data-ren="' + it.id + '">' + icon("pencil") + "Rename</button>" +
        '<label class="sr-only" for="vdMove">Move ' + esc(it.name) + ' to</label><select class="vd-select" id="vdMove" data-move="' + it.id + '">' + opts + "</select>" +
        (dir ? "" : '<button type="button" class="vd-btn" data-del="' + it.id + '">' + icon("trash") + "Delete</button>") + "</div>";
    }

    function renderBin() {
      binCount.textContent = trash.length;
      bin.setAttribute("aria-expanded", String(showTrash));
      $("span", bin).textContent = showTrash ? "Back to vault" : "Recycle Bin";
    }
    function render() { renderTags(); renderTree(); renderDetail(); renderBin(); }

    function moveTo(id, folderId) {
      var it = byId(id); if (!it) return;
      if (folderId != null && (folderId === id || isInside(id, folderId))) return;
      if (it.parent === folderId) return;
      it.parent = folderId;
      if (folderId != null) expanded[folderId] = true;
      fresh = id; selected = id;
      say(it.name + " moved to " + (folderId != null ? byId(folderId).name : "the vault root"));
      render();
    }
    function toTrash(id) {
      var it = byId(id); if (!it) return;
      items = items.filter(function (x) { return x.id !== id; });
      it.days = 0; it.from = it.parent; trash.unshift(it);
      if (selected === id) selected = null;
      say(it.name + " moved to the Recycle Bin");
      render();
      binCount.classList.remove("bump"); void binCount.offsetWidth; binCount.classList.add("bump");
      bin.focus();
    }
    function commitRename(inp, save) {
      var it = byId(+inp.getAttribute("data-rename"));
      renaming = null;
      if (save && it) { var v = inp.value.trim(); if (v && v !== it.name) { it.name = v; say("Renamed to " + v); } }
      render();
      var b = it && $('[data-sel="' + it.id + '"]', tree); if (b) b.focus();
    }

    // events
    tagsEl.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-clear")) tagFilter = [];
      else { var t = b.getAttribute("data-tag"), i = tagFilter.indexOf(t); if (i >= 0) tagFilter.splice(i, 1); else tagFilter.push(t); }
      showTrash = false; render();
      var again = $('[data-tag="' + (b.getAttribute("data-tag") || "") + '"]', tagsEl); if (again) again.focus();
    });
    search.addEventListener("input", function () { query = search.value.trim(); showTrash = false; renderTree(); renderBin(); renderDetail(); });

    var panel = $(".vx-side");
    panel.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b || !panel.contains(b)) return;
      var id;
      if ((id = b.getAttribute("data-sel"))) {
        id = +id; var it = byId(id);
        if (it.kind === "folder") expanded[id] = !expanded[id];
        selected = id; renderTree(); renderDetail();
        var nb = $('[data-sel="' + id + '"]', tree); if (nb) nb.focus();
      } else if ((id = b.getAttribute("data-star"))) {
        var s = byId(+id); s.starred = !s.starred; say(s.name + (s.starred ? " starred" : " unstarred"));
        renderTree(); renderDetail();
        var sb = $('[data-star="' + id + '"]', tree); if (sb) sb.focus();
      } else if ((id = b.getAttribute("data-del"))) {
        toTrash(+id);
      } else if ((id = b.getAttribute("data-restore"))) {
        id = +id;
        var r = trash.filter(function (x) { return x.id === id; })[0];
        trash = trash.filter(function (x) { return x.id !== id; });
        r.parent = r.from != null && byId(r.from) ? r.from : null; delete r.days;
        items.push(r); if (r.parent != null) expanded[r.parent] = true; selected = r.id; fresh = r.id;
        say(r.name + " restored");
        render(); bin.focus();
      } else if ((id = b.getAttribute("data-purge"))) {
        id = +id;
        var gone = trash.filter(function (x) { return x.id === id; })[0];
        trash = trash.filter(function (x) { return x.id !== id; });
        say(gone.name + " deleted forever");
        render(); bin.focus();
      }
    });
    detail.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      var id;
      if ((id = b.getAttribute("data-ren"))) { renaming = +id; renderTree(); }
      else if ((id = b.getAttribute("data-star"))) { var s = byId(+id); s.starred = !s.starred; say(s.name + (s.starred ? " starred" : " unstarred")); renderTree(); renderDetail(); var x = $("[data-star]", detail); if (x) x.focus(); }
      else if ((id = b.getAttribute("data-del"))) toTrash(+id);
    });
    detail.addEventListener("change", function (e) {
      var s = e.target.closest("[data-move]"); if (!s) return;
      moveTo(+s.getAttribute("data-move"), s.value ? +s.value : null);
      var ns = $("[data-move]", detail); if (ns) ns.focus();
    });
    tree.addEventListener("dblclick", function (e) {
      var row = e.target.closest(".vt-row"); if (!row) return;
      renaming = +row.getAttribute("data-id"); selected = renaming; renderTree(); renderDetail();
    });
    tree.addEventListener("keydown", function (e) {
      var inp = e.target.closest("[data-rename]");
      if (inp) { if (e.key === "Enter") { e.preventDefault(); commitRename(inp, true); } else if (e.key === "Escape") { e.preventDefault(); commitRename(inp, false); } return; }
      var b = e.target.closest("[data-sel]");
      if (b && e.key === "F2") { e.preventDefault(); renaming = +b.getAttribute("data-sel"); renderTree(); }
      if (b && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        var all = $$("[data-sel]", tree), i = all.indexOf(b), n = all[i + (e.key === "ArrowDown" ? 1 : -1)];
        if (n) n.focus();
      }
    });
    tree.addEventListener("focusout", function (e) {
      var inp = e.target.closest && e.target.closest("[data-rename]");
      if (inp) setTimeout(function () { if (renaming != null) commitRename(inp, true); }, 0);
    });
    // drag and drop
    tree.addEventListener("dragstart", function (e) {
      var row = e.target.closest(".vt-row"); if (!row) return;
      dragId = +row.getAttribute("data-id");
      try { e.dataTransfer.setData("text/plain", String(dragId)); e.dataTransfer.effectAllowed = "move"; } catch (x) { /* ignore */ }
      setTimeout(function () { row.classList.add("is-drag"); }, 0);
    });
    tree.addEventListener("dragend", function () { dragId = null; $$(".is-drag,.is-drop", tree).forEach(function (r) { r.classList.remove("is-drag", "is-drop"); }); });
    function dropTarget(e) {
      var row = e.target.closest(".vt-row");
      if (!row) return { el: null, folder: null };
      var it = byId(+row.getAttribute("data-id"));
      return { el: row, folder: it.kind === "folder" ? it.id : it.parent };
    }
    tree.addEventListener("dragover", function (e) {
      if (dragId == null) return;
      var t = dropTarget(e);
      if (t.folder != null && (t.folder === dragId || isInside(dragId, t.folder))) return;
      e.preventDefault();
      $$(".is-drop", tree).forEach(function (r) { r.classList.remove("is-drop"); });
      var hl = t.folder != null ? $('.vt-row[data-id="' + t.folder + '"]', tree) : null;
      if (hl) hl.classList.add("is-drop");
    });
    tree.addEventListener("drop", function (e) {
      if (dragId == null) return;
      e.preventDefault();
      var t = dropTarget(e), id = dragId; dragId = null;
      moveTo(id, t.folder);
    });
    bin.addEventListener("click", function () { showTrash = !showTrash; if (showTrash) { tagFilter = []; } render(); });
    // lock / unlock (and the real panic shortcut, while the demo is on screen)
    function lock() { lockedEl.hidden = false; say("Vault locked"); unlockBtn.focus(); }
    function unlock() { lockedEl.hidden = true; say("Vault unlocked"); lockBtn.focus(); }
    lockBtn.addEventListener("click", lock);
    unlockBtn.addEventListener("click", unlock);
    var vaultP = player($("#vaultDemo"));
    doc.addEventListener("keydown", function (e) {
      if (e.ctrlKey && e.altKey && (e.key === "l" || e.key === "L") && vaultP.inView && lockedEl.hidden) { e.preventDefault(); lock(); }
    });
    render();
  })();

  /* ── Credentials demo ────────────────────────────────────── */
  (function () {
    // tabs
    var tabs = $$('#credDemo [role="tab"]');
    function select(t, focus) {
      tabs.forEach(function (x) {
        var on = x === t;
        x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1;
        $("#" + x.getAttribute("aria-controls")).hidden = !on;
      });
      if (focus) t.focus();
      closePop();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(t); });
      t.addEventListener("keydown", function (e) {
        var n = null;
        if (e.key === "ArrowRight") n = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") n = tabs[0];
        else if (e.key === "End") n = tabs[tabs.length - 1];
        if (n) { e.preventDefault(); select(n, true); }
      });
    });

    // copy buttons with 20 s clipboard countdown
    var note = $("#clipNote"), defaultNote = note.textContent, clipTimer = 0, clipTick = 0, activeRing = null;
    $$("#credDemo .cp").forEach(function (b) {
      var label = b.getAttribute("data-label");
      b.innerHTML = icon("copy", "ic-copy") + icon("check", "ic-check") + '<svg class="ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" pathLength="100"/></svg>';
      b.setAttribute("aria-label", "Copy " + label);
      b.setAttribute("data-tip", "Copy " + label);
      b.addEventListener("click", function () {
        var src = $(b.getAttribute("data-copy"));
        var val = (src.value != null ? src.value : src.textContent).trim();
        if (b.getAttribute("data-copy") === "#totpCode") val = val.replace(/\s/g, "");
        var copied = false;
        try { if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(val).catch(function () {}); copied = true; } } catch (e) { /* ignore */ }
        // feedback: check mark, tooltip, countdown ring
        $$("#credDemo .cp.is-copied").forEach(function (o) { if (o !== b) o.classList.remove("is-copied"); });
        if (activeRing && activeRing !== b) { var oc = $(".ring circle", activeRing); oc.style.transition = "none"; oc.style.strokeDashoffset = "0"; }
        b.classList.add("is-copied", "tip-on");
        b.setAttribute("data-tip", "Copied");
        b.setAttribute("aria-label", label + " copied");
        var c = $(".ring circle", b);
        c.style.transition = "none"; c.style.strokeDashoffset = "0"; void c.getBoundingClientRect();
        c.style.transition = "stroke-dashoffset 20s linear"; c.style.strokeDashoffset = "100";
        activeRing = b;
        setTimeout(function () { b.classList.remove("tip-on"); b.setAttribute("data-tip", "Copy " + label); b.setAttribute("aria-label", "Copy " + label); }, 1500);
        clearInterval(clipTick); clearTimeout(clipTimer);
        var left = 20, name = label.charAt(0).toUpperCase() + label.slice(1);
        var feet = $$("#credDemo .cred-foot");
        var setNote = function (t, live) { note.textContent = t; note.classList.toggle("is-live", !!live); };
        setNote(name + " copied. Clipboard clears in " + left + " s.", true);
        clipTick = setInterval(function () {
          left -= 1;
          if (left > 0) setNote(name + " copied. Clipboard clears in " + left + " s.", true);
        }, 1000);
        clipTimer = setTimeout(function () {
          clearInterval(clipTick);
          b.classList.remove("is-copied");
          try { if (copied) navigator.clipboard.writeText("").catch(function () {}); } catch (e) { /* ignore */ }
          setNote("Clipboard cleared.", false);
          setTimeout(function () { setNote(defaultNote, false); }, 3000);
        }, 20000);
        void feet;
      });
    });

    // show / hide secret fields
    function eye(btn, input, noun) {
      btn.addEventListener("click", function () {
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.setAttribute("aria-pressed", String(show));
        btn.setAttribute("aria-label", (show ? "Hide " : "Show ") + noun);
        $("use", btn).setAttribute("href", show ? "#i-eye-off" : "#i-eye");
      });
    }
    var pass = $("#lgPass"), eyeBtn = $("#lgEye");
    eye(eyeBtn, pass, "password");
    eye($("#apEye"), $("#apKey"), "key");
    function reveal() { if (pass.type === "password") eyeBtn.click(); }

    // password generator
    var SETS = { lower: "abcdefghijklmnopqrstuvwxyz", upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", digits: "0123456789", symbols: "!@#$%^&*()-_=+[]{};:,.?/~" };
    var AMB = /[lIO01o]/g;
    var pop = $("#pwPop"), gen = $("#lgGen"), genOpts = $("#lgGenOpts"), out = $("#pwOut"), len = $("#pwLen"), lenOut = $("#pwLenOut");
    var amb = $("#pwAmb"), remember = $("#pwRemember"), bar = $("#pwBar"), bits = $("#pwBits");
    var boxes = $$(".pw-grid input", pop), ask = true, current = "", opener = gen;
    function options() {
      var o = { length: +len.value, avoid: amb.checked, sets: [] };
      boxes.forEach(function (b) { if (b.checked) o.sets.push(b.getAttribute("data-cls")); });
      return o;
    }
    function generate(o) {
      var pools = o.sets.map(function (k) { return o.avoid ? SETS[k].replace(AMB, "") : SETS[k]; });
      var all = pools.join(""), chars = [];
      pools.forEach(function (p) { chars.push(p[randInt(p.length)]); }); // at least one of each class
      while (chars.length < o.length) chars.push(all[randInt(all.length)]);
      for (var i = chars.length - 1; i > 0; i--) { var j = randInt(i + 1), t = chars[i]; chars[i] = chars[j]; chars[j] = t; }
      return { pw: chars.join(""), bits: Math.round(o.length * Math.log2(all.length)) };
    }
    function refresh() {
      var o = options();
      boxes.forEach(function (b) { b.disabled = b.checked && o.sets.length === 1; });
      lenOut.textContent = o.length;
      var g = generate(o); current = g.pw;
      out.innerHTML = g.pw.split("").map(function (c) {
        return /[0-9]/.test(c) ? '<span class="d">' + c + "</span>" : /[a-zA-Z]/.test(c) ? c : '<span class="s">' + esc(c) + "</span>";
      }).join("");
      bits.textContent = "≈ " + g.bits + " bits";
      bar.style.transform = "scaleX(" + Math.min(1, g.bits / 128).toFixed(3) + ")";
      bar.style.backgroundColor = g.bits < 60 ? "var(--w-bad)" : g.bits < 90 ? "var(--w-warn)" : "var(--w-ok)";
    }
    function openPop(from) {
      opener = from || gen;
      pop.hidden = false; gen.setAttribute("aria-expanded", "true"); genOpts.setAttribute("aria-expanded", "true");
      remember.checked = !ask;
      refresh(); len.focus();
    }
    function closePop(restore) {
      if (pop.hidden) return;
      pop.hidden = true; gen.setAttribute("aria-expanded", "false"); genOpts.setAttribute("aria-expanded", "false");
      if (restore) opener.focus();
    }
    function use(pw) { pass.value = pw; reveal(); pass.classList.remove("flash"); void pass.offsetWidth; }
    gen.addEventListener("click", function () {
      if (!ask) { use(generate(options()).pw); return; }
      if (pop.hidden) openPop(gen); else closePop(true);
    });
    genOpts.addEventListener("click", function () { if (pop.hidden) openPop(genOpts); else closePop(true); });
    $("#pwAgain").addEventListener("click", refresh);
    len.addEventListener("input", refresh);
    amb.addEventListener("change", refresh);
    boxes.forEach(function (b) { b.addEventListener("change", refresh); });
    $("#pwUse").addEventListener("click", function () {
      ask = !remember.checked;
      genOpts.hidden = ask;
      use(current); closePop(true);
    });
    pop.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); closePop(true); } });
    doc.addEventListener("pointerdown", function (e) { if (!pop.hidden && !e.target.closest(".gen-wrap")) closePop(false); });

    // live 2-step code (demo: random digits per 30 s window)
    var codeEl = $("#totpCode"), arc = $("#totpArc"), leftEl = $("#totpLeft"), totpRow = $(".totp"), lastWin = -1;
    function tickTotp() {
      var now = Date.now(), win = Math.floor(now / 30000), left = 30 - Math.floor((now / 1000) % 30);
      if (win !== lastWin) {
        lastWin = win;
        var d = ""; for (var i = 0; i < 6; i++) d += randInt(10);
        codeEl.textContent = d.slice(0, 3) + " " + d.slice(3);
      }
      leftEl.textContent = left + "s";
      arc.style.strokeDashoffset = String((1 - left / 30) * 100);
      totpRow.classList.toggle("is-low", left <= 5);
    }
    var totpTimer = 0;
    tickTotp();
    player($("#credDemo"), function (active) {
      clearInterval(totpTimer);
      if (active) { tickTotp(); totpTimer = setInterval(tickTotp, 1000); }
    });

    // SSH: command builder, port check, key analysis
    var host = $("#shHost"), port = $("#shPort"), user = $("#shUser"), cmd = $("#shCmd"), perr = $("#shPortErr");
    function updateCmd() {
      port.value = port.value.replace(/\D/g, "").slice(0, 5);
      var pn = port.value ? +port.value : 22, bad = port.value && (pn < 1 || pn > 65535);
      perr.hidden = !bad; perr.textContent = bad ? "Port must be between 1 and 65535." : "";
      port.setAttribute("aria-invalid", String(!!bad));
      var h = host.value.trim(), u = user.value.trim();
      cmd.textContent = h ? "ssh " + (u ? u + "@" : "") + h + (port.value && pn !== 22 && !bad ? " -p " + pn : "") : "Add a host to build the command";
    }
    [host, port, user].forEach(function (el) { el.addEventListener("input", updateCmd); });
    updateCmd();

    var keyIn = $("#shKey"), keyState = $("#shKeyState");
    function b64(bytes) { var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
    function sshString(str) { var b = typeof str === "string" ? new TextEncoder().encode(str) : str; var o = new Uint8Array(4 + b.length); new DataView(o.buffer).setUint32(0, b.length); o.set(b, 4); return o; }
    function concat(parts) { var n = 0; parts.forEach(function (p) { n += p.length; }); var o = new Uint8Array(n), k = 0; parts.forEach(function (p) { o.set(p, k); k += p.length; }); return o; }
    function wrap(s) { return s.match(/.{1,70}/g).join("\n"); }
    function sampleOpenssh(cipher) {
      var body = concat([new TextEncoder().encode("openssh-key-v1\0"), sshString(cipher), sshString(cipher === "none" ? "none" : "bcrypt"),
        sshString(cipher === "none" ? new Uint8Array(0) : randBytes(24)), new Uint8Array([0, 0, 0, 1]), randBytes(150)]);
      return "-----BEGIN OPENSSH PRIVATE KEY-----\n" + wrap(b64(body)) + "\n-----END OPENSSH PRIVATE KEY-----";
    }
    var SAMPLES = {
      ok: function () { return sampleOpenssh("none"); },
      enc: function () { return sampleOpenssh("aes256-ctr"); },
      pub: function () { return "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + b64(randBytes(24)).replace(/=+$/, "") + " deploy@laptop"; },
      cut: function () { return sampleOpenssh("none").replace(/\n-----END[\s\S]*$/, "").split("\n").slice(0, 3).join("\n"); }
    };
    function opensshCipher(body) {
      try {
        var raw = atob(body), magic = "openssh-key-v1\0";
        if (raw.slice(0, magic.length) !== magic) return null;
        var o = magic.length, n = (raw.charCodeAt(o) << 24) | (raw.charCodeAt(o + 1) << 16) | (raw.charCodeAt(o + 2) << 8) | raw.charCodeAt(o + 3);
        if (n <= 0 || n > 64) return null;
        return raw.slice(o + 4, o + 4 + n);
      } catch (e) { return null; }
    }
    function analyzeKey(text) { // mirrors src/lib/sshEntry.ts
      var t = text.trim();
      if (!t) return { state: "empty", label: "Paste a key and Notiq checks it before saving" };
      if (/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+|sk-\S+)\s+[A-Za-z0-9+/=]+/.test(t) || /^-----BEGIN (SSH2 )?PUBLIC KEY-----/.test(t)) return { state: "public", label: "That's a public key. Paste the private key instead." };
      if (/^PuTTY-User-Key-File-\d+:/m.test(t)) { var enc = (/^Encryption:\s*(\S+)/m.exec(t) || [])[1]; return enc && enc !== "none" ? { state: "encrypted", label: "PuTTY key (.ppk) · passphrase protected" } : { state: "ok", label: "PuTTY key (.ppk) · not encrypted" }; }
      var m = /^-----BEGIN ([A-Z0-9 ]+)-----/.exec(t);
      if (!m) return { state: "invalid", label: "This doesn't look like a private key" };
      var kind = m[1];
      if (!new RegExp("-----END " + kind + "-----").test(t)) return { state: "incomplete", label: "Key is cut off: the END line is missing" };
      var body = t.split("\n").filter(function (l) { return l && l.indexOf("-----") !== 0 && !/^[A-Za-z-]+:/.test(l) && l[0] !== " "; }).join("");
      if (kind === "OPENSSH PRIVATE KEY") {
        var c = opensshCipher(body);
        if (c === null) return { state: "invalid", label: "OpenSSH key looks damaged" };
        return c === "none" ? { state: "ok", label: "OpenSSH private key · not encrypted" } : { state: "encrypted", label: "OpenSSH private key · passphrase protected (" + c + ")" };
      }
      if (kind === "ENCRYPTED PRIVATE KEY" || /Proc-Type:\s*4,ENCRYPTED/.test(t)) return { state: "encrypted", label: "PEM private key · passphrase protected" };
      if (/^(RSA |EC |DSA )?PRIVATE KEY$/.test(kind)) return { state: "ok", label: (kind.replace(" PRIVATE KEY", "").replace("PRIVATE KEY", "PKCS#8") || "PKCS#8") + " private key · not encrypted" };
      return { state: "invalid", label: "Unrecognised key type (" + kind.toLowerCase() + ")" };
    }
    function analyze() {
      var r = analyzeKey(keyIn.value);
      var tone = r.state === "ok" ? "ok" : r.state === "encrypted" ? "encrypted" : r.state === "empty" ? "empty" : "bad";
      var ic = tone === "ok" ? "shield" : tone === "encrypted" ? "login" : tone === "empty" ? "shield" : "alert";
      keyState.setAttribute("data-state", tone);
      keyState.innerHTML = icon(ic) + "<span>" + esc(r.label) + "</span>";
      keyState.classList.remove("flash"); void keyState.offsetWidth; if (!reduce) keyState.classList.add("flash");
    }
    keyIn.addEventListener("input", analyze);
    $$("#cp-ssh [data-sample]").forEach(function (b) {
      b.addEventListener("click", function () { keyIn.value = SAMPLES[b.getAttribute("data-sample")](); analyze(); });
    });
  })();

  /* ── One file: hex scramble + key steps ──────────────────── */
  (function () {
    var flow = $("#flowDemo"), hexEl = $("#flowHex"), steps = $$("#flowSteps li");
    var bytes = hexEl.textContent.trim().split(/\s+/);
    if (reduce) { steps.forEach(function (s) { s.classList.add("on"); }); return; }
    var p = player(flow, function (a) { flow.classList.toggle("is-playing", a); });
    (async function () {
      var stepI = 0, t = 0;
      for (;;) {
        await p.gate();
        var changed = {};
        for (var k = 0; k < 7; k++) { var i = rnd(bytes.length); bytes[i] = HEX[rnd(16)] + HEX[rnd(16)]; changed[i] = 1; }
        var html = "";
        for (var j = 0; j < bytes.length; j++) {
          html += (changed[j] ? "<b>" + bytes[j] + "</b>" : bytes[j]) + ((j + 1) % 16 === 0 ? "\n" : " ");
        }
        hexEl.innerHTML = html.trim();
        if (t++ % 12 === 0) { steps.forEach(function (s, n) { s.classList.toggle("on", n <= stepI); }); stepI = (stepI + 1) % (steps.length + 1); }
        await p.sleep(130);
      }
    })();
  })();

  /* ── Knowledge graph ─────────────────────────────────────── */
  (function () {
    var box = $("#graphDemo"), svg = $("#graphSvg"), gE = $(".g-edges", svg), gN = $(".g-nodes", svg);
    var W = 760, H = 300, NS = "http://www.w3.org/2000/svg";
    var names = ["Projects", "Roadmap", "Meeting Oct", "Runbook", "Ideas", "Reading list", "Weekend project", "Q4 goals", "Design notes", "API docs", "Retro", "Journal", "Deep Work"];
    var links = [[0, 1], [0, 2], [0, 3], [0, 7], [1, 7], [1, 8], [2, 10], [2, 7], [3, 9], [4, 6], [4, 5], [5, 12], [6, 5], [8, 9], [11, 4], [11, 12], [10, 1], [0, 4]];
    var deg = names.map(function () { return 0; });
    links.forEach(function (l) { deg[l[0]]++; deg[l[1]]++; });
    var nodes = names.map(function (n, i) {
      var a = i / names.length * Math.PI * 2;
      return { name: n, x: W / 2 + Math.cos(a) * 320, y: H / 2 + Math.sin(a) * 90, vx: 0, vy: 0, r: 5 + deg[i] * 1.6, ph: Math.random() * 6.28 };
    });
    // settle with a small force simulation, synchronously
    for (var it = 0; it < 400; it++) {
      for (var i = 0; i < nodes.length; i++) for (var j = i + 1; j < nodes.length; j++) {
        var a = nodes[i], b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + .01, f = 9000 / d2;
        var d = Math.sqrt(d2); a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
      }
      links.forEach(function (l) {
        var a = nodes[l[0]], b = nodes[l[1]], dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - 130) * .02;
        a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
      });
      nodes.forEach(function (n) {
        n.vx += (W / 2 - n.x) * .0006; n.vy += (H / 2 - n.y) * .01;
        n.x += n.vx * .5; n.y += n.vy * .5; n.vx *= .6; n.vy *= .6;
        n.x = Math.max(56, Math.min(W - 56, n.x)); n.y = Math.max(20, Math.min(H - 30, n.y));
      });
    }
    var lines = links.map(function (l) { var e = doc.createElementNS(NS, "line"); gE.appendChild(e); return e; });
    var gs = nodes.map(function (n, i) {
      var g = doc.createElementNS(NS, "g"); g.setAttribute("class", "g-node" + (i === 0 ? " hub" : ""));
      var c = doc.createElementNS(NS, "circle"); c.setAttribute("r", n.r.toFixed(1));
      var t = doc.createElementNS(NS, "text"); t.setAttribute("y", (n.r + 13).toFixed(1)); t.setAttribute("text-anchor", "middle"); t.textContent = n.name;
      g.appendChild(c); g.appendChild(t); gN.appendChild(g);
      g.addEventListener("pointerenter", function () {
        box.classList.add("is-hover"); g.classList.add("hl");
        links.forEach(function (l, k) {
          if (l[0] === i || l[1] === i) { lines[k].classList.add("hl"); gs[l[0]].classList.add("hl"); gs[l[1]].classList.add("hl"); }
        });
      });
      g.addEventListener("pointerleave", function () {
        box.classList.remove("is-hover");
        $$(".hl", svg).forEach(function (x) { x.classList.remove("hl"); });
      });
      return g;
    });
    function draw(t) {
      var pos = nodes.map(function (n) {
        var ox = reduce ? 0 : Math.sin(t / 1900 + n.ph) * 4, oy = reduce ? 0 : Math.cos(t / 2300 + n.ph) * 3;
        return [n.x + ox, n.y + oy];
      });
      gs.forEach(function (g, i) { g.setAttribute("transform", "translate(" + pos[i][0].toFixed(1) + " " + pos[i][1].toFixed(1) + ")"); });
      links.forEach(function (l, k) {
        var e = lines[k];
        e.setAttribute("x1", pos[l[0]][0].toFixed(1)); e.setAttribute("y1", pos[l[0]][1].toFixed(1));
        e.setAttribute("x2", pos[l[1]][0].toFixed(1)); e.setAttribute("y2", pos[l[1]][1].toFixed(1));
      });
    }
    draw(0);
    if (reduce) return;
    var raf = 0, last = 0;
    function frame(t) { if (t - last > 33) { draw(t); last = t; } raf = requestAnimationFrame(frame); }
    player(box, function (a) { cancelAnimationFrame(raf); if (a) raf = requestAnimationFrame(frame); });
  })();

  /* ── Whiteboard ──────────────────────────────────────────── */
  (function () {
    var b = $("#boardDemo");
    if (reduce) return;
    player(b, function (a) { b.classList.add("is-playing"); b.classList.toggle("is-paused", !a); });
  })();

  /* ── AI chat + terminal typing ───────────────────────────── */
  (function () {
    if (reduce) return;
    var chat = $("#chatDemo"), me = $(".msg.me", chat), ai = $("#chatAi");
    var convo = [
      ["Summarize this week's meeting notes", "Three decisions: ship the importer Friday, move standup to 10:00, and retire the old export script."],
      ["Suggest a title for this note", "“Importer rollout plan: dates, owners and the rollback runbook.”"],
      ["Fix the grammar in my selection", "Done. I tightened two sentences and fixed a missing article. Review the change before accepting."]
    ];
    var pc = player(chat);
    (async function () {
      for (var n = 0; ; n = (n + 1) % convo.length) {
        me.textContent = convo[n][0]; ai.textContent = "";
        await pc.sleep(900);
        var text = convo[n][1];
        for (var i = 1; i <= text.length; i++) { ai.textContent = text.slice(0, i); await pc.sleep(text[i - 1] === " " ? 34 : 16 + rnd(18)); }
        await pc.sleep(3200);
      }
    })();

    var term = $("#termDemo");
    var script = [
      ["git pull", "Already up to date."],
      ["ls notes/", "ideas.md  meeting-oct.md  roadmap.md  runbook.md"],
      ["npm run build", "<span class=\"t-ok\">done</span> <span class=\"t-dim\">in 1.84s</span>"]
    ];
    var pt = player(term);
    (async function () {
      for (;;) {
        var hist = "";
        for (var s = 0; s < script.length; s++) {
          var c = script[s][0];
          for (var i = 0; i <= c.length; i++) {
            term.innerHTML = hist + '<span class="t-p">~/notes $</span> ' + esc(c.slice(0, i)) + '<i class="caret"></i>';
            await pt.sleep(i === 0 ? 500 : 55 + rnd(60));
          }
          await pt.sleep(350);
          hist += '<span class="t-p">~/notes $</span> ' + esc(c) + "\n" + script[s][1] + "\n";
          term.innerHTML = hist + '<span class="t-p">~/notes $</span> <i class="caret"></i>';
          await pt.sleep(900);
        }
        await pt.sleep(2600);
      }
    })();
  })();
})();
