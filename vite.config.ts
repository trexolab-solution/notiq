import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { APP_NAME, APP_VERSION, APP_DESCRIPTION, APP_IDENTIFIER } from "./src/config/app";
const host = (globalThis as Record<string, unknown>).process
  ? (((globalThis as Record<string, unknown>).process as Record<string, Record<string, string>>).env?.TAURI_DEV_HOST)
  : undefined;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  define: {
    __APP_NAME__: JSON.stringify(APP_NAME),
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_DESCRIPTION__: JSON.stringify(APP_DESCRIPTION),
    __APP_IDENTIFIER__: JSON.stringify(APP_IDENTIFIER),
  },

  clearScreen: false,

  optimizeDeps: {
    include: ["3d-force-graph", "react-kapsule", "three"],
    // The umbrella react-force-graph imports 3d-force-graph-vr which calls
    // AFRAME.registerComponent at module load — crashes without A-Frame runtime.
    exclude: ["react-force-graph"],
  },

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-monaco": ["@monaco-editor/react", "monaco-editor"],
          "vendor-excalidraw":  ["@excalidraw/excalidraw"],
          "vendor-3d-graph": ["3d-force-graph", "react-kapsule", "three"],
          "vendor-markdown": ["react-markdown", "remark-gfm", "rehype-highlight"],
          "vendor-state": ["zustand", "idb"],
        },
      },
    },
  },
}));
