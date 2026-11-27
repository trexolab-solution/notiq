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
        // Heavy libs (monaco, excalidraw, three, react-markdown) are deliberately NOT forced into named
        // vendor chunks: those became shared bins that the entry statically imported, defeating lazy loading.
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-state": ["zustand", "idb"],
        },
      },
    },
  },
}));
