/**
 * Format source code using Prettier (for languages it supports) or Monaco's
 * built-in formatter (JSON, TypeScript, JavaScript, HTML, CSS).
 *
 * Returns the formatted text, or null if no formatter is available / an error
 * occurred (the caller shows a toast with the error message).
 */
import type * as monaco from "monaco-editor";

// Prettier parser names keyed by Monaco language id
const PRETTIER_PARSERS: Record<string, string> = {
  javascript:  "babel",
  typescript:  "typescript",
  css:         "css",
  scss:        "scss",
  less:        "less",
  html:        "html",
  json:        "json",
  jsonc:       "json",
  markdown:    "markdown",
  yaml:        "yaml",
  graphql:     "graphql",
};

// Languages where Monaco's built-in formatter is preferred over Prettier
// (Monaco JSON/TS/JS/CSS/HTML formatters are fast and language-aware).
const PREFER_MONACO = new Set(["json", "jsonc", "typescript", "javascript", "css", "scss", "less", "html"]);

export async function formatDocument(
  editor: monaco.editor.IStandaloneCodeEditor,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const model = editor.getModel();
  if (!model) return { ok: false, message: "No document open" };

  const lang = model.getLanguageId();

  // ── Monaco built-in formatter ──────────────────────────────────────────────
  if (PREFER_MONACO.has(lang)) {
    try {
      await editor.getAction("editor.action.formatDocument")?.run();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  }

  // ── Prettier ───────────────────────────────────────────────────────────────
  const parserName = PRETTIER_PARSERS[lang];
  if (!parserName) {
    // Fall back to Monaco format (some languages have basic support)
    try {
      await editor.getAction("editor.action.formatDocument")?.run();
      return { ok: true };
    } catch {
      return { ok: false, message: `No formatter available for language "${lang}"` };
    }
  }

  try {
    const prettier = await import("prettier/standalone");
    // Load only the plugin(s) needed for this parser
    const plugin   = await loadPlugin(parserName);
    const original = model.getValue();
    const formatted = await prettier.format(original, {
      parser:           parserName,
      plugins:          plugin ? [plugin] : [],
      // Editor settings
      tabWidth:         model.getOptions().tabSize ?? 2,
      useTabs:          !model.getOptions().insertSpaces,
      printWidth:       88,
      singleQuote:      false,
      trailingComma:    "all",
      semi:             true,
      bracketSpacing:   true,
      arrowParens:      "always",
      proseWrap:        "preserve",
    });

    if (formatted === original) return { ok: true };

    // Apply as a single undoable edit
    const fullRange = model.getFullModelRange();
    editor.executeEdits("prettier", [{ range: fullRange, text: formatted }]);
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { ok: false, message: msg };
  }
}

async function loadPlugin(parserName: string): Promise<unknown> {
  switch (parserName) {
    case "babel":
    case "typescript": {
      const [estree, babel] = await Promise.all([
        import("prettier/plugins/estree"),
        import("prettier/plugins/babel"),
      ]);
      if (parserName === "typescript") {
        const mod = await import("prettier/plugins/typescript");
        return mod.default ?? mod;
      }
      return { ...babel.default ?? babel, ...estree.default ?? estree };
    }
    case "css":
    case "scss":
    case "less": {
      const mod = await import("prettier/plugins/postcss"); return mod.default ?? mod;
    }
    case "html": {
      const mod = await import("prettier/plugins/html"); return mod.default ?? mod;
    }
    case "json": {
      const mod = await import("prettier/plugins/babel"); return mod.default ?? mod;
    }
    case "markdown": {
      const mod = await import("prettier/plugins/markdown"); return mod.default ?? mod;
    }
    case "yaml": {
      const mod = await import("prettier/plugins/yaml"); return mod.default ?? mod;
    }
    case "graphql": {
      const mod = await import("prettier/plugins/graphql"); return mod.default ?? mod;
    }
    default:
      return null;
  }
}
