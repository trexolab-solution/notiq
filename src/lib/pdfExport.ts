import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MarkdownPreview } from "../components/editor/MarkdownPreview";
import { useAppStore } from "../store";
import { toast } from "./toast";
import { isVaultPath } from "./vault";

/**
 * PDF export via the webview's native print-to-PDF.
 *
 * Instead of re-implementing markdown rendering (the old jsPDF builder could
 * only flatten text and dropped images/math/mermaid/Devanagari), we mount the
 * real <MarkdownPreview> into an off-screen "print root", wait for its async
 * bits (Mermaid diagrams, images, fonts) to settle, then ask the Rust side to
 * print the current page to a PDF file. `print.css` (@media print) hides
 * everything except the print root, so the output is exactly the preview —
 * mermaid, KaTeX, syntax highlighting, images and all — with full fidelity.
 *
 * The native path is silent (no OS print dialog). The only dialog shown is the
 * native "Save As" file picker, used to choose the destination — the same UX
 * the previous exporter had.
 */

const PRINT_ROOT_ID = "notiq-print-root";
const RESULT_EVENT = "notiq:pdf-export-result";

export interface PdfResult {
  success: boolean;
  error: string;
  path: string;
}

/** Count fenced ```mermaid / ~~~mermaid blocks so we know how many diagrams to await. */
function countMermaidBlocks(md: string): number {
  const matches = md.match(/^[ \t]{0,3}(?:```|~~~)[ \t]*mermaid\b/gm);
  return matches ? matches.length : 0;
}

/** Resolve after two animation frames — lets React commit + the browser lay out. */
function nextFrames(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/**
 * Wait until the off-screen preview has finished rendering its async content:
 * Mermaid diagrams (rendered in a useEffect), images, and web fonts. Bounded by
 * `timeoutMs` so a stuck diagram/image never hangs the export.
 */
async function waitForRender(root: HTMLElement, content: string, timeoutMs = 8000): Promise<void> {
  const start = performance.now();
  const expectedMermaid = countMermaidBlocks(content);

  // 1. Mermaid renders asynchronously — poll until each block produced an <svg>
  //    (or a .mermaid-error), or we run out of time.
  if (expectedMermaid > 0) {
    while (performance.now() - start < timeoutMs) {
      const done = root.querySelectorAll(".mermaid-container svg, .mermaid-error").length;
      if (done >= expectedMermaid) break;
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  // 2. Images — wait for load/error, each capped so a slow/broken URL can't hang.
  //    The preview marks images loading="lazy"; off-screen (below the fold) they
  //    would never load here, so force eager loading before we wait on them.
  const imgs = Array.from(root.querySelectorAll("img")) as HTMLImageElement[];
  imgs.forEach((img) => {
    if (img.loading === "lazy") img.loading = "eager";
  });
  await Promise.all(
    imgs.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const done = () => resolve();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
            setTimeout(done, 4000);
          }),
    ),
  );

  // 3. Fonts settled + a couple of frames so final layout is stable.
  try {
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
  } catch {
    /* fonts API unavailable — ignore */
  }
  await nextFrames();
}

/** Run the native print-to-PDF and resolve with its result event (or reject on timeout). */
export function nativePrint(path: string): Promise<PdfResult> {
  return new Promise<PdfResult>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unlisten.then((u) => u()).catch(() => {});
      reject(new Error("PDF export timed out"));
    }, 30_000);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten.then((u) => u()).catch(() => {});
      fn();
    };

    // Register the completion listener BEFORE invoking, then kick off the export.
    const unlisten = listen<PdfResult>(RESULT_EVENT, (evt) => {
      finish(() => resolve(evt.payload));
    });

    unlisten
      .then(() => invoke("export_pdf", { path }))
      .catch((err) => finish(() => reject(err)));
  });
}

/**
 * Export markdown `content` as a PDF, rendered identically to the live preview.
 * Shows a native "Save As" dialog. Never throws — some call sites invoke this
 * without awaiting/catching, so failures are logged rather than propagated.
 */
export async function exportToPDF(title: string, content: string): Promise<void> {
  try {
    if (!content || !content.trim()) return; // nothing to export

    const savePath = await save({
      title: "Export as PDF",
      defaultPath: `${title}.pdf`,
      filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    });
    if (!savePath) return; // user cancelled

    // Exporting a vault note writes a plain, unencrypted PDF — make that explicit.
    const st = useAppStore.getState();
    if (isVaultPath(st.tabs.find((t) => t.id === st.activeTabId)?.filePath)) {
      toast.warning("This PDF is not encrypted — anyone with the file can read it");
    }

    // Mount an off-screen, print-only render of the note.
    const container = document.createElement("div");
    container.id = PRINT_ROOT_ID;
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      root.render(createElement(MarkdownPreview, { content }));
      await waitForRender(container, content);

      const result = await nativePrint(savePath);
      if (!result.success) {
        throw new Error(result.error || "Native PDF export failed");
      }
    } finally {
      root.unmount();
      container.remove();
    }
  } catch (err) {
    console.error("PDF export failed:", err);
  }
}
