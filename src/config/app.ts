// ─── Single source of truth for app metadata ───────────────────────────────
// When changing these values, also update:
//   • src-tauri/tauri.conf.json  → productName, app.windows[0].title, identifier
//   • src-tauri/Cargo.toml       → [package] name, [lib] name, description
//   • package.json               → name
//
// Icon source: src/assets/logo.png (1254×1254 px)
//   To regenerate Tauri icons run:  bun run icons
//   Web favicon is public/favicon.png (copy of logo.png)

export const APP_NAME = 'Notiq'
export const APP_VERSION = '0.3.0'
export const APP_DESCRIPTION = 'A smart note-taking application'
export const APP_IDENTIFIER = 'com.trexolab.notiq'

// Resolved at build time via vite.config.ts `define`; available as __APP_NAME__ etc.
