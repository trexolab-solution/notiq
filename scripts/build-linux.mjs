import { execSync } from 'node:child_process'
import { mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const IMAGE_NAME = 'notiq-linux-builder'
const CONTAINER_NAME = 'notiq-linux-build'
const OUTPUT_DIR = 'dist-linux'

console.log('[build-linux] Starting Linux build via Docker...\n')

// Ensure Docker is available
try {
  execSync('docker --version', { stdio: 'pipe' })
} catch {
  console.error('[build-linux] Docker not found. Please install Docker Desktop.')
  process.exit(1)
}

// ── Updater signing key (required — createUpdaterArtifacts is enabled) ────────
// The key is passed into the build as a BuildKit secret (never copied into the
// image or baked into a layer). Override the path with TAURI_SIGNING_PRIVATE_KEY_PATH.
const KEY_FILE = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || 'notiq-updater.key'
if (!existsSync(KEY_FILE)) {
  console.error(
    `[build-linux] Updater signing key not found: ${KEY_FILE}\n` +
    `  Generate it once:  bun tauri signer generate -w notiq-updater.key\n` +
    `  (or set TAURI_SIGNING_PRIVATE_KEY_PATH to point at your key file).`
  )
  process.exit(1)
}
const KEY_PASSWORD = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''

// Clean output directory
if (existsSync(OUTPUT_DIR)) {
  rmSync(OUTPUT_DIR, { recursive: true })
}
mkdirSync(OUTPUT_DIR, { recursive: true })

// Build Docker image
console.log('[build-linux] Building Docker image (this may take a while on first run)...')
try {
  // Pass the key password only when set — as a BuildKit secret (never ARG/ENV).
  // An empty (no-password) key needs no secret; the Dockerfile mount is optional.
  const pwSecret = KEY_PASSWORD
    ? `--secret id=signing_key_password,env=TAURI_SIGNING_PRIVATE_KEY_PASSWORD `
    : ''
  execSync(
    `docker build -f docker/Dockerfile.linux ` +
      `--secret id=signing_key,src="${KEY_FILE}" ` +
      pwSecret +
      `-t ${IMAGE_NAME} .`,
    { stdio: 'inherit', env: { ...process.env, DOCKER_BUILDKIT: '1', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: KEY_PASSWORD } }
  )
} catch {
  console.error('[build-linux] Docker build failed.')
  process.exit(1)
}

// Remove any previous container with the same name
try {
  execSync(`docker rm ${CONTAINER_NAME}`, { stdio: 'pipe' })
} catch {
  // Container didn't exist — that's fine
}

// Create a temporary container to extract artifacts
console.log('[build-linux] Extracting build artifacts...')
try {
  execSync(`docker create --name ${CONTAINER_NAME} ${IMAGE_NAME}`, { stdio: 'pipe' })
  execSync(`docker cp ${CONTAINER_NAME}:/output/. ${OUTPUT_DIR}/`, { stdio: 'pipe' })
  execSync(`docker rm ${CONTAINER_NAME}`, { stdio: 'pipe' })
} catch (err) {
  console.error('[build-linux] Failed to extract artifacts:', err.message)
  // Clean up container on failure
  try { execSync(`docker rm ${CONTAINER_NAME}`, { stdio: 'pipe' }) } catch {}
  process.exit(1)
}

// List results
const artifacts = readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.deb') || f.endsWith('.AppImage') || f.endsWith('.sig'))
const installers = artifacts.filter(f => !f.endsWith('.sig'))

if (installers.length === 0) {
  console.error('[build-linux] No .deb or .AppImage files found. Build may have failed.')
  process.exit(1)
}

console.log(`\n[build-linux] Build complete! Artifacts in ${OUTPUT_DIR}/:\n`)
for (const file of artifacts) {
  console.log(`  → ${file}`)
}
console.log()
