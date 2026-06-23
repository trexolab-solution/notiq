import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { platform } from 'node:os'

const isLinux = platform() === 'linux'

// ── Helper: hash-based change detection ─────────────────────────────────────
function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function cachedHash(hashFile) {
  return existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim() : ''
}

// ── App logo → Tauri icons ──────────────────────────────────────────────────
const LOGO = './src/assets/logo.png'
const LOGO_HASH_FILE = '.icon-hash'

if (!existsSync(LOGO)) {
  console.warn('[sync-icons] src/assets/logo.png not found — skipping icon generation')
} else {
  const hash = fileHash(LOGO)
  if (hash === cachedHash(LOGO_HASH_FILE)) {
    console.log('[sync-icons] logo.png unchanged — skipping')
  } else {
    console.log('[sync-icons] logo.png changed — regenerating Tauri icons...')
    execSync(`bun run tauri icon "${LOGO}"`, { stdio: 'inherit' })
    writeFileSync(LOGO_HASH_FILE, hash)
    console.log('[sync-icons] logo.png done.')
  }
}

// ── File-association icon → ICO + PNG ───────────────────────────────────────
const ASSOC_SRC = './src/assets/association.png'
const ASSOC_ICO = './src-tauri/icons/association.ico'
const ASSOC_PNG = './src-tauri/icons/association.png'
const ASSOC_HASH_FILE = '.assoc-icon-hash'

if (!existsSync(ASSOC_SRC)) {
  console.warn('[sync-icons] association.png not found — skipping association icon')
} else {
  const hash = fileHash(ASSOC_SRC)
  if (hash === cachedHash(ASSOC_HASH_FILE)) {
    console.log('[sync-icons] association.png unchanged — skipping')
  } else {
    console.log('[sync-icons] association.png changed — regenerating association icon...')
    if (!isLinux) {
      execSync(`python3 scripts/png-to-ico.py "${ASSOC_SRC}" "${ASSOC_ICO}"`, { stdio: 'inherit' })
    } else {
      console.log('[sync-icons] skipping ICO generation on Linux (not needed)')
    }
    copyFileSync(ASSOC_SRC, ASSOC_PNG)
    writeFileSync(ASSOC_HASH_FILE, hash)
    console.log('[sync-icons] association icon done.')
  }
}
