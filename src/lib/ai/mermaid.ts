// Shared Mermaid validation. Mirrors MarkdownPreview's init so re-initializing
// here never changes the preview's global config.

let _init = false;

/** Returns null if the Mermaid code parses, else the parser error message. */
export async function validateMermaid(code: string): Promise<string | null> {
  try {
    const m = (await import("mermaid")).default;
    if (!_init) {
      m.initialize({
        startOnLoad: false, theme: "dark", securityLevel: "strict",
        fontFamily: "Inter, Segoe UI, system-ui, sans-serif", fontSize: 14,
      });
      _init = true;
    }
    await m.parse(code.trim());
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
