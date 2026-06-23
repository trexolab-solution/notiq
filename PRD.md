You are a senior desktop application architect and frontend performance expert.

I am building a cross-platform desktop application using:

* Tauri (Rust backend)
* Vite + React + TypeScript
* Bun (as package manager and runtime)
* Tailwind CSS (latest version)

This application is a modern Markdown-first editor inspired by Notepad++, with a strong focus on performance, modularity, theming, and extensibility.

---

# 🎯 Core Goals

1. High-performance Markdown editor (no typing lag)
2. Clean modular architecture
3. Advanced theming system (like VS Code)
4. Persistent session recovery (even unsaved data)
5. Rich editor + raw markdown editor
6. Real-time preview + knowledge graph

---

# ⚙️ Tooling Requirements

* Use Bun instead of npm/yarn
* Use latest Tailwind CSS
* Use PostCSS if needed
* Configure Vite properly for Tauri

---

# 🎨 Tailwind + Theming System (IMPORTANT)

### Requirements:

* Use Tailwind CSS for all styling
* Implement **design tokens using CSS variables**
* Tailwind should use those variables

### Example:

:root {
--color-bg: #0f172a;
--color-text: #e5e7eb;
--color-primary: #c9a84c;
}

### Tailwind config must map:

colors: {
bg: "var(--color-bg)",
text: "var(--color-text)",
primary: "var(--color-primary)"
}

---

### Theme Features:

* Light / Dark / Custom themes
* Instant switching (no reload)
* Persist theme in storage
* Apply theme globally

---

# ⚡ Performance (MANDATORY)

* Use React.memo, useCallback, useMemo
* Debounce heavy operations (preview rendering)
* Lazy load modules
* Code splitting via Vite
* Avoid unnecessary re-renders

---

# 🧠 State Management

Use Zustand with:

* Modular slices
* Persist middleware

State should include:

* Tabs
* Editor content
* Theme
* Session
* Graph

---

# 💾 Session Persistence

* Auto-save all data continuously
* Restore on app launch:
  * Tabs
  * Unsaved files
  * Cursor position

Use:

* IndexedDB OR Tauri filesystem API

---

# 📝 Editor System

* Raw Markdown Editor:
  * Monaco Editor
* Rich Editor:
  * TipTap

---

# 📊 Knowledge Graph

* Parse [[links]] from markdown
* Build graph
* Render using:
  * D3.js or react-force-graph

---

# 📄 Markdown → PDF

* Export document to PDF
* Keep styling same as preview
* Prefer Tauri backend for performance

---

# 🧩 UI System (Tailwind-based)

* Build reusable UI components:
  * Button
  * Input
  * Panel
  * Tabs
* Follow clean modern design
* Dark theme default

---

# 📦 Bun Commands

Use:

* bun install
* bun add
* bun run

---

# 🎯 Expected Output

1. Full project structure
2. Tailwind setup with theme system
3. Zustand store setup
4. Editor integration
5. Session persistence implementation
6. Modular architecture code

---

# ❗ Strict Rules

* No vague explanations
* Production-grade code only
* Strong TypeScript typing
* Clean architecture
* Explain decisions briefly

---

Start with:

1. Project setup (Bun + Vite + Tailwind + Tauri)
2. Tailwind theme system (code)
3. Folder structure
4. Then implement features step-by-step
