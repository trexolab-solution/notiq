import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  transformChrome, transformStore, transformFirefox, referencedFiles, validateBuild, crc32, createZip, FIREFOX_ID,
} from "../build.mjs";

const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json"), "utf8"));
const fileMap = (m) => new Map([["manifest.json", Buffer.from(JSON.stringify(m))], ...referencedFiles(m).map((f) => [f, Buffer.from("x")])]);

test("chrome keeps key", () => assert.equal(transformChrome(manifest).key, manifest.key));
test("store drops key, keeps service worker", () => {
  const m = transformStore(manifest);
  assert.equal("key" in m, false);
  assert.equal(m.background.service_worker, "background.js");
});
test("firefox transform", () => {
  const m = transformFirefox(manifest);
  assert.equal("key" in m, false);
  assert.deepEqual(m.background, { scripts: ["shared.js", "background.js"] });
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
test("content scripts load shared.js before content.js", () => {
  assert.deepEqual(manifest.content_scripts[0].js, ["shared.js", "content.js"]);
});
test("no new permissions in 0.4.0", () => {
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "nativeMessaging", "scripting", "storage"]);
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
