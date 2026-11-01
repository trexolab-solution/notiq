import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  transformChrome, transformStore, transformFirefox, referencedFiles, validateBuild, crc32, createZip, FIREFOX_ID,
  parsePslData, pslBlock, syncPsl, PSL_SOURCE, DYNAMIC_SCRIPTS,
} from "../build.mjs";

const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json"), "utf8"));
const fileMap = (m) => new Map([["manifest.json", Buffer.from(JSON.stringify(m))],
  ...[...referencedFiles(m), "passkeys.js", ...DYNAMIC_SCRIPTS].map((f) => [f, Buffer.from("x")])]);

test("chrome keeps key", () => assert.equal(transformChrome(manifest).key, manifest.key));
test("store drops key, keeps service worker", () => {
  const m = transformStore(manifest);
  assert.equal("key" in m, false);
  assert.equal(m.background.service_worker, "background.js");
});
test("firefox transform", () => {
  const m = transformFirefox(manifest);
  assert.equal("key" in m, false);
  assert.deepEqual(m.background, { scripts: ["shared.js", "identity.js", "passkeys.js", "background.js"] });
  assert.equal(m.browser_specific_settings.gecko.id, FIREFOX_ID);
  assert.equal(m.browser_specific_settings.gecko.strict_min_version, "121.0");
  assert.deepEqual(m.permissions, manifest.permissions);
  assert.deepEqual(m.content_scripts, manifest.content_scripts);
});
test("transforms do not mutate input", () => {
  const before = JSON.stringify(manifest);
  transformFirefox(manifest);
  transformStore(manifest);
  assert.equal(JSON.stringify(manifest), before);
});
test("validate accepts all variants", () => {
  validateBuild(transformChrome(manifest), fileMap(manifest), manifest.version);
  validateBuild(transformStore(manifest), fileMap(manifest), manifest.version, { store: true });
  validateBuild(transformFirefox(manifest), fileMap(manifest), manifest.version, { firefox: true });
});
test("validate rejects key in store, missing file, wrong version", () => {
  assert.throws(() => validateBuild(manifest, fileMap(manifest), manifest.version, { store: true }), /key/);
  const files = fileMap(manifest);
  files.delete("content.js");
  assert.throws(() => validateBuild(manifest, files, manifest.version), /missing/);
  assert.throws(() => validateBuild(manifest, fileMap(manifest), "9.9.9"), /version/);
});
test("validate rejects a build without shared.js", () => {
  const files = fileMap(manifest);
  files.delete("shared.js");
  assert.throws(() => validateBuild(manifest, files, manifest.version), /shared\.js/);
});
test("validate rejects a build without the passkey scripts (registered at run time, not in the manifest)", () => {
  assert.deepEqual(DYNAMIC_SCRIPTS, ["passkey-page.js", "passkey-bridge.js"]);
  for (const f of ["passkeys.js", ...DYNAMIC_SCRIPTS]) {
    const files = fileMap(manifest);
    files.delete(f);
    assert.throws(() => validateBuild(manifest, files, manifest.version), new RegExp(f.replace(".", "\\.")));
  }
});
test("passkeys: the only optional permission is host access for the content script's own sites", () => {
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*", "http://localhost/*"]);
  assert.equal("host_permissions" in manifest, false, "no host access is granted up front");
  const cs = new Set(manifest.content_scripts[0].matches);
  for (const o of manifest.optional_host_permissions) assert.ok(cs.has(o), o);
});
test("content scripts load shared.js, fillkit.js and identity.js before content.js", () => {
  assert.deepEqual(manifest.content_scripts[0].js, ["shared.js", "fillkit.js", "identity.js", "content.js"]);
});
test("validate rejects a build without identity.js (the background loads it)", () => {
  const files = fileMap(manifest);
  files.delete("identity.js");
  assert.throws(() => validateBuild(manifest, files, manifest.version), /identity\.js/);
});
test("permissions: only contextMenus added since 0.4.0 (the right-click menu)", () => {
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "contextMenus", "nativeMessaging", "scripting", "storage"]);
  assert.equal("host_permissions" in manifest, false);
  assert.equal("web_accessible_resources" in manifest, false);
});
test("crc32 known value", () => assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926));
test("zip is deterministic and readable", () => {
  const entries = new Map([["b.txt", Buffer.from("hello hello hello hello")], ["a/c.txt", Buffer.alloc(0)]]);
  const z1 = createZip(entries);
  assert.ok(z1.equals(createZip(entries)));
  const eocd = z1.length - 22;
  assert.equal(z1.readUInt32LE(eocd), 0x06054b50);
  assert.equal(z1.readUInt16LE(eocd + 10), 2);
  const cdOff = z1.readUInt32LE(eocd + 16);
  assert.equal(z1.readUInt32LE(cdOff), 0x02014b50);
  const nlen = z1.readUInt16LE(cdOff + 28);
  assert.equal(z1.subarray(cdOff + 46, cdOff + 46 + nlen).toString(), "a/c.txt");
  const off2 = z1.readUInt32LE(cdOff + 46 + nlen + 42);
  const csize = z1.readUInt32LE(off2 + 18);
  const n2 = z1.readUInt16LE(off2 + 26);
  const body = z1.subarray(off2 + 30 + n2, off2 + 30 + n2 + csize);
  assert.equal((z1.readUInt16LE(off2 + 8) === 8 ? inflateRawSync(body) : body).toString(), "hello hello hello hello");
});

// The installer copies the extension from tauri.conf.json's resources; a file missing there makes
// "Load unpacked" fail on the installed copy even though the repo folder works.
test("every file the extension needs ships in the installer resources", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const conf = JSON.parse(readFileSync(join(dir, "..", "..", "src-tauri", "tauri.conf.json"), "utf8"));
  const shipped = new Set(Object.values(conf.bundle.resources).filter((v) => v.startsWith("browser-extension/")).map((v) => v.slice("browser-extension/".length)));
  for (const f of ["manifest.json", ...referencedFiles(manifest)]) assert.ok(shipped.has(f), `${f} missing from tauri.conf.json bundle.resources`);
});

// ---------- Public Suffix List snapshot in shared.js ----------
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pslTs = readFileSync(join(root, PSL_SOURCE), "utf8");
const sharedJs = readFileSync(join(root, "browser-extension", "shared.js"), "utf8");

test("PSL: shared.js carries the app's current table (refresh: node browser-extension/build.mjs --psl)", () => {
  assert.equal(syncPsl(sharedJs, pslTs), sharedJs);
});
test("PSL: parsed table has the ICANN and private-section suffixes the same-site rule relies on", () => {
  const d = parsePslData(pslTs);
  assert.ok(d.second.uk.split(" ").includes("co"));
  assert.ok(d.second.jp.split(" ").includes("co"));
  for (const s of ["github.io", "herokuapp.com", "vercel.app", "blogspot.com", "netlify.app", "pages.dev", "web.app",
    "firebaseapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "s3.amazonaws.com"]) {
    assert.ok(d.extra.includes(s), s);
  }
  assert.ok(d.wildcard.includes("kawasaki.jp") && d.exception.includes("city.kawasaki.jp"));
});
test("PSL: syncPsl replaces only the block and rejects files without one", () => {
  const fake = ["a", "  // BEGIN PSL old", "  const PSL = {};", "  // END PSL", "b"].join("\n");
  const out = syncPsl(fake, pslTs);
  assert.ok(out.startsWith("a\n") && out.endsWith("\nb"));
  assert.ok(out.includes(pslBlock(parsePslData(pslTs))));
  assert.throws(() => syncPsl("no block", pslTs));
  assert.throws(() => parsePslData("export const SECOND_LEVEL = {};"));
});
