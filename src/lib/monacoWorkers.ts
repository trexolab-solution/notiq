/**
 * Configure Monaco language workers so every language gets its full feature set:
 * folding, IntelliSense, diagnostics, hover, formatting, etc.
 *
 * Must be imported once, before any Monaco editor is created.
 * Vite's `?worker` query bundles each worker as a separate chunk and provides
 * a stable URL — no CDN, works fully offline inside Tauri.
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker   from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker    from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker   from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker     from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Tell Monaco how to spawn each language worker
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === "json")                                    return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript")    return new tsWorker();
    return new editorWorker();
  },
};

// Point the react wrapper at the already-imported monaco instance so it
// doesn't try to fetch it from a CDN (critical for offline Tauri builds).
loader.config({ monaco });
