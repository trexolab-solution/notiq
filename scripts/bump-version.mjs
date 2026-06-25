#!/usr/bin/env node
// Sync the app version across all FOUR sources of truth in one shot, so a release
// can never ship with mismatched versions (the #1 footgun in the manual runbook).
//   Usage:  bun run bump 1.2.3     (or:  node scripts/bump-version.mjs 1.2.3)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(
    `Usage: bun run bump <version>  (semver, e.g. 1.2.3)\nGot: ${version ?? "(nothing)"}`,
  );
  process.exit(1);
}

/** Replace in a file via regex; fail loudly if the pattern isn't found. */
function patch(relPath, pattern, replacement, label) {
  const file = join(root, relPath);
  const before = readFileSync(file, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before) {
    console.error(`✗ ${relPath}: could not find ${label} (already ${version}?)`);
    process.exit(1);
  }
  writeFileSync(file, after);
  console.log(`✓ ${relPath}`);
}

patch("package.json", /("version":\s*")[^"]*(")/, `$1${version}$2`, "package version");
patch("src-tauri/tauri.conf.json", /("version":\s*")[^"]*(")/, `$1${version}$2`, "version");
patch("src-tauri/Cargo.toml", /^(version = ")[^"]*(")/m, `$1${version}$2`, "package version");
patch("src/config/app.ts", /(APP_VERSION = ')[^']*(')/, `$1${version}$2`, "APP_VERSION");

console.log(`\nVersion set to ${version} across all four files.`);
console.log(`Next: commit, then  git tag v${version} && git push origin v${version}  to trigger the release workflow.`);
