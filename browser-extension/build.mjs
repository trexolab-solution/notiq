#!/usr/bin/env node
// Packages the Notiq Autofill extension. No dependencies (Node 20+).
//   node browser-extension/build.mjs [--out dist] [--check]
// Writes three reproducible zips:
//   notiq-autofill-<ver>-chrome.zip   sideload / GitHub release (keeps manifest `key` => stable extension ID)
//   notiq-autofill-<ver>-store.zip    Chrome Web Store + Edge Add-ons (`key` removed; the store assigns the ID)
//   notiq-autofill-<ver>-firefox.zip  Firefox / AMO (background.scripts + gecko settings, `key` removed)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FIREFOX_ID = "autofill@notiq.app";
export const FIREFOX_MIN = "121.0";
// Fixed timestamp so identical input gives byte-identical zips: 2026-01-01 00:00:00 (DOS format).
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

// ---------- manifest transforms (pure) ----------
const clone = (o) => JSON.parse(JSON.stringify(o));

export function transformChrome(m) {
  return clone(m);
}

export function transformStore(m) {
  const out = clone(m);
  delete out.key;
  return out;
}

export function transformFirefox(m) {
  const out = clone(m);
  delete out.key;
  const bg = out.background || {};
  const script = bg.service_worker || (bg.scripts && bg.scripts[0]) || "background.js";
  out.background = { scripts: [script] };
  out.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ID,
      strict_min_version: FIREFOX_MIN,
      // AMO requires this declaration for new extensions (honoured by Firefox 140+, ignored by older versions).
      data_collection_permissions: { required: ["none"] },
    },
  };
  // Chrome-only manifest keys; none are used today, dropped defensively.
  for (const k of ["minimum_chrome_version", "update_url", "externally_connectable", "incognito"]) delete out[k];
  return out;
}

// Every file the manifest points at (relative paths).
export function referencedFiles(m) {
  const files = new Set();
  const bg = m.background || {};
  if (bg.service_worker) files.add(bg.service_worker);
  for (const s of bg.scripts || []) files.add(s);
  for (const cs of m.content_scripts || []) {
    for (const f of [...(cs.js || []), ...(cs.css || [])]) files.add(f);
  }
  if (m.action?.default_popup) files.add(m.action.default_popup);
  for (const f of Object.values(m.icons || {})) files.add(f);
  for (const f of Object.values(m.action?.default_icon || {})) files.add(f);
  return [...files];
}

// Throws on the first problem. `files` is a Map name -> Buffer.
export function validateBuild(manifest, files, version, { store = false, firefox = false } = {}) {
  if (manifest.manifest_version !== 3) throw new Error("manifest_version must be 3");
  if (manifest.version !== version) throw new Error(`version ${manifest.version} != ${version}`);
  if ((store || firefox) && "key" in manifest) throw new Error("`key` must not be present in this build");
  if (!store && !firefox && !manifest.key) throw new Error("sideload build must keep `key`");
  for (const f of referencedFiles(manifest)) {
    if (!files.has(f)) throw new Error(`manifest references missing file: ${f}`);
  }
  for (const [size, f] of Object.entries(manifest.icons || {})) {
    if (!files.has(f)) throw new Error(`icon ${size} missing: ${f}`);
  }
  if (firefox) {
    if (manifest.background?.service_worker) throw new Error("firefox build must not use service_worker");
    if (manifest.background?.scripts?.[0] !== "background.js") throw new Error("firefox build needs background.scripts");
    if (manifest.browser_specific_settings?.gecko?.id !== FIREFOX_ID) throw new Error("firefox gecko id missing");
  } else if (!manifest.background?.service_worker) {
    throw new Error("chromium build needs background.service_worker");
  }
  for (const p of ["nativeMessaging", "storage", "activeTab", "scripting"]) {
    if (!manifest.permissions?.includes(p)) throw new Error(`permission missing: ${p}`);
  }
  if (!manifest.content_scripts?.length) throw new Error("content_scripts missing");
  JSON.parse(files.get("manifest.json").toString("utf8"));
}

// ---------- ZIP writer ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: Map name -> Buffer. Names are written sorted with forward slashes.
export function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of [...entries.keys()].sort()) {
    if (name.includes("\\") || name.startsWith("/")) throw new Error(`bad zip path: ${name}`);
    const data = entries.get(name);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // no extra field
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by (MS-DOS, 2.0)
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    // extra, comment, disk, internal attrs, external attrs: all 0
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- main ----------
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const oi = args.indexOf("--out");
  const outDir = resolve(oi >= 0 && args[oi + 1] ? args[oi + 1] : "dist");

  const base = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  const version = base.version;
  const runtime = new Set(["manifest.json", ...referencedFiles(base)]);
  // Files the popup page loads (e.g. popup.js) are not in the manifest; pick them up from its HTML.
  if (base.action?.default_popup) {
    const html = readFileSync(join(here, base.action.default_popup), "utf8");
    for (const m of html.matchAll(/(?:src|href)="([^"#?:]+)"/g)) runtime.add(m[1]);
  }
  const source = new Map();
  for (const f of [...runtime].sort()) {
    const p = join(here, f);
    if (!existsSync(p)) throw new Error(`runtime file missing: ${f}`);
    source.set(f, readFileSync(p));
  }

  const variants = [
    { name: "chrome", transform: transformChrome, opts: {} },
    { name: "store", transform: transformStore, opts: { store: true } },
    { name: "firefox", transform: transformFirefox, opts: { firefox: true } },
  ];
  if (!check) mkdirSync(outDir, { recursive: true });

  const rows = [];
  for (const v of variants) {
    const manifest = v.transform(base);
    const files = new Map(source);
    files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
    validateBuild(manifest, files, version, v.opts);
    const zip = createZip(files);
    const file = `notiq-autofill-${version}-${v.name}.zip`;
    if (!check) writeFileSync(join(outDir, file), zip);
    rows.push({ file, files: files.size, bytes: zip.length, sha256: createHash("sha256").update(zip).digest("hex") });
  }

  console.log(check ? `Checked v${version} (nothing written)` : `Wrote v${version} to ${outDir}`);
  const w = Math.max(...rows.map((r) => r.file.length));
  for (const r of rows) {
    console.log(`${r.file.padEnd(w)}  ${String(r.files).padStart(2)} files  ${String(r.bytes).padStart(7)} B  ${r.sha256}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error("build failed:", e.message);
    process.exit(1);
  }
}
