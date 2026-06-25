import { defineConfig } from "vitest/config";

// Vitest runs in a Node environment: the unit tests target pure, framework-free
// logic (text helpers, path utils, relevance scoring). Anything that needs the
// store, Tauri APIs, or the DOM is mocked per-test rather than loaded for real.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
  },
});
