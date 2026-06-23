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

// Clean output directory
if (existsSync(OUTPUT_DIR)) {
  rmSync(OUTPUT_DIR, { recursive: true })
}
mkdirSync(OUTPUT_DIR, { recursive: true })

// Build Docker image
console.log('[build-linux] Building Docker image (this may take a while on first run)...')
try {
  execSync(
    `docker build -f docker/Dockerfile.linux -t ${IMAGE_NAME} .`,
    { stdio: 'inherit' }
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
const artifacts = readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.deb') || f.endsWith('.AppImage'))

if (artifacts.length === 0) {
  console.error('[build-linux] No .deb or .AppImage files found. Build may have failed.')
  process.exit(1)
}

console.log(`\n[build-linux] Build complete! Artifacts in ${OUTPUT_DIR}/:\n`)
for (const file of artifacts) {
  console.log(`  → ${file}`)
}
console.log()
