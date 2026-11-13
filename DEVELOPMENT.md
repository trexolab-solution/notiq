# Developing Notiq

Everything for building and changing the app. For what Notiq does, see the [README](README.md) and the [website](https://trexolab-solution.github.io/notiq/).

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Bun](https://bun.sh/) — package manager and script runner
- [Rust](https://www.rust-lang.org/tools/install) + Cargo
- [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) for your OS (WebView2 on Windows)

### Install

```bash
git clone https://github.com/trexolab-solution/notiq.git
cd notiq
bun install
```

### Run in development

```bash
bun run tauri dev
```

Starts the Vite dev server on `http://localhost:1420` and opens the Tauri window with hot module replacement.

**Dev builds are kept apart from an installed Notiq**, so you can run both on one machine. A debug build runs as `com.trexolab.notiq.dev` ("Notiq (Dev)", with a **DEV** badge in the title bar):

| | Installed (release) | Dev (`tauri dev`) |
|---|---|---|
| App data (settings, `vault.json`, `vault.nqdb`) | `%APPDATA%\com.trexolab.notiq\` | `%APPDATA%\com.trexolab.notiq.dev\` |
| WebView storage (tabs, preferences) | `%LOCALAPPDATA%\com.trexolab.notiq\` | `%LOCALAPPDATA%\com.trexolab.notiq.dev\` |
| AI API key (OS keychain) | `notiq-ai` | `notiq-ai-dev` |

A dev build also never registers file associations, the browser-autofill native host or auto-start, and never self-updates, because those are machine-wide and belong to the installed app. To try the browser extension against a dev build you have to register its native host yourself. See `src-tauri/src/profile.rs`.

### Build for production

```bash
bun run tauri build
```

The installer is output to `src-tauri/target/release/bundle/`.

### Cross-compile a Linux build (from Windows/macOS)

```bash
bun run build:linux
```

Spins up a Docker container (defined in `docker/Dockerfile.linux`) that produces `.deb` and `.AppImage` artifacts in `dist-linux/`. Requires Docker Desktop.

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri v2](https://tauri.app/) (Rust) |
| UI framework | [React 18](https://react.dev/) + TypeScript |
| Build tool | [Vite 6](https://vite.dev/) |
| Styling | [Tailwind CSS v4](https://tailwindcss.com/) + CSS custom properties |
| State management | [Zustand v5](https://github.com/pmndrs/zustand) |
| Code editor | [Monaco Editor](https://microsoft.github.io/monaco-editor/) |
| Markdown rendering | [react-markdown](https://github.com/remarkjs/react-markdown) + remark-gfm + rehype-highlight + rehype-katex |
| Diagrams | [Mermaid](https://mermaid.js.org/) |
| Whiteboard | [Excalidraw](https://excalidraw.com/) |
| Knowledge graph | [3d-force-graph](https://github.com/vasturiano/3d-force-graph) (via [react-kapsule](https://github.com/vasturiano/react-kapsule)) + Three.js |
| Terminal | [xterm.js](https://xtermjs.org/) + portable-pty (Rust) for local shells, [russh](https://github.com/warp-tech/russh) for built-in SSH |
| AI | [Ollama](https://ollama.com/) Cloud + Local and [OpenRouter](https://openrouter.ai/) (OpenAI-compatible) via Rust `reqwest` |
| Secret storage | OS keychain via [keyring](https://crates.io/crates/keyring) (Rust) |
| Drag & drop | [@dnd-kit](https://dndkit.com/) |
| Session storage | IndexedDB via [idb](https://github.com/jakearchibald/idb) |
| PDF export | [jsPDF](https://github.com/parallax/jsPDF) |
| Icons | [Lucide](https://lucide.dev/) |

## Project Structure

```
notiq/
├── src/                          # React frontend
│   ├── main.tsx                  # Entry point — routes to main / sticky-note / list window
│   ├── mainApp.tsx               # Main window bootstrap (theme hydration, show)
│   ├── App.tsx                   # Root component — shortcuts, context menus, layout
│   ├── App.css                   # Global styles and Tailwind theme tokens
│   ├── assets/                   # App logo and static assets
│   ├── components/
│   │   ├── ai/                   # AI chat panel + onboarding wizard
│   │   ├── editor/               # Monaco editor, preview, toolbar, split view
│   │   ├── graph/                # 3D force-directed knowledge graph
│   │   ├── layout/               # Sidebar, TabBar, StatusBar, titlebar, menus
│   │   ├── whiteboard/           # Excalidraw canvas integration
│   │   ├── sticky-note/          # Sticky note window + sticky notes list
│   │   ├── terminal/             # Embedded xterm.js terminal (multi-session)
│   │   └── ui/                   # Reusable components (Button, Modal, Toast, etc.)
│   ├── store/                    # Zustand store (tabs, prefs, sticky notes)
│   ├── lib/                      # Utilities (file I/O, session, themes, graph, PDF)
│   │   └── ai/                   # AI client, prompts, actions, inline completions
│   ├── hooks/                    # React hooks (shortcuts, session, scroll sync)
│   ├── types/                    # TypeScript type definitions
│   ├── config/                   # App metadata (name, version, identifier)
│   └── styles/                   # Theme CSS variables
├── src-tauri/                    # Tauri backend (Rust)
│   ├── src/lib.rs                # Commands, file associations, PTY, tray, plugins
│   ├── src/ai.rs                 # AI backend — Ollama / OpenRouter proxy + secure key storage
│   ├── src/vault*.rs             # Secure Vault — crypto core, encrypted database (vault.nqdb), commands
│   ├── src/autofill.rs           # Browser autofill bridge (native messaging)
│   ├── src/sync/                 # Vault Sync — Google Drive provider, merge engine, sealing
│   ├── tauri.conf.json           # App config, window, bundling, file associations
│   ├── capabilities/             # Permission scopes (main + sticky note windows)
│   ├── nsis/                     # Windows installer hooks
│   ├── linux/                    # Linux .desktop template
│   ├── mime/                     # Linux MIME type registration
│   └── icons/                    # Platform-specific app icons
├── docker/Dockerfile.linux       # Reproducible Linux build environment
├── scripts/                      # Icon sync + Linux build helpers
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Tauri v2 (Rust)                      │
│  File I/O · PTY terminal · System tray · File assoc.     │
└────────────────────────┬─────────────────────────────────┘
                         │ IPC (invoke / events)
┌────────────────────────▼─────────────────────────────────┐
│                   React 18 Frontend                      │
│                                                          │
│  ┌─────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ TabBar  │  │   Editor     │  │  Knowledge Graph   │  │
│  │ (dnd-   │  │  (Monaco +   │  │  (3D force-graph)  │  │
│  │  kit)   │  │   Preview)   │  │                    │  │
│  └─────────┘  └──────────────┘  └────────────────────┘  │
│  ┌─────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │Sidebar  │  │  Whiteboard  │  │     Terminal       │  │
│  │+ Themes │  │ (Excalidraw) │  │    (xterm.js)      │  │
│  └─────────┘  └──────────────┘  └────────────────────┘  │
│                         │                                │
│              ┌──────────▼──────────┐                     │
│              │   Zustand Store     │                     │
│              │  tabs · theme ·     │                     │
│              │  prefs · graph      │                     │
│              └──────────┬──────────┘                     │
│                         │                                │
│              ┌──────────▼──────────┐                     │
│              │  IndexedDB Session  │                     │
│              │  (auto-persist)     │                     │
│              └─────────────────────┘                     │
└──────────────────────────────────────────────────────────┘
```

**Key design decisions:**

- **Debounced persistence** — content changes are batched (300ms) before writing to IndexedDB to avoid excessive writes
- **Lazy-loaded views** — Whiteboard, Knowledge Graph, and Terminal are code-split and loaded on demand
- **Session hydration before render** — the window stays hidden until IndexedDB restores the previous session, preventing visual flash
- **Single instance** — Tauri enforces one running instance; opening a file externally sends it to the existing window
- **Vault sync is encrypted client-side** — the vault is sealed on the PC before the Rust sync module uploads it to Drive's app-data folder; Google never sees plaintext
- **AI proxied through Rust** — all AI requests go through the Rust backend, so the API key never touches the web layer and there are no CORS constraints; AI is disabled by default
