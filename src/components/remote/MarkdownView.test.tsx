// @vitest-environment happy-dom
/** MarkdownView: a page with the editor preview's look; raw HTML isn't run, links go to the browser, web pictures stay as text. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const openUrl = vi.fn(async (_u: string) => {});
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { MarkdownView, OPENABLE_LINK } = await import("./MarkdownView");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); openUrl.mockClear(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const render = async (text: string) => { await act(async () => { root.render(<MarkdownView text={text} />); }); };
const q = (sel: string) => document.querySelector(sel);

describe("MarkdownView", () => {
  it("shows headings, lists, tables, task lists and code", async () => {
    await render("# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n```js\nconst x = 1;\n```\n");
    expect(q("h1")!.textContent).toBe("Title");
    expect(document.querySelectorAll("li").length).toBeGreaterThanOrEqual(4);
    expect(q("table th")!.textContent).toBe("a");
    expect(document.querySelectorAll("input[type=checkbox]")).toHaveLength(2);
    expect(q("pre code")!.textContent).toContain("const x = 1;");
  });

  it("uses the editor preview's page layout", async () => {
    await render("hello");
    expect(q(".prose-scroll .prose-body")).toBeTruthy();
  });

  it("does not run raw HTML in the file", async () => {
    await render('<script>window.__pwned = 1</script>\n\n<img src="http://evil.test/x.png" onerror="window.__pwned = 2">\n\n<b onclick="x()">bold</b>');
    expect(q("script")).toBeNull();
    expect(q("img")).toBeNull();
    expect(q("b")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("opens web and mail links in the system's apps, and nothing else", async () => {
    await render("[site](https://example.com/a) [mail](mailto:a@b.co) [bad](javascript:alert(1)) [file](file:///C:/x) [rel](notes/other.md)");
    const links = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://example.com/a", "mailto:a@b.co"]);
    await act(async () => { (document.querySelector("a") as HTMLAnchorElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a");
    expect(document.body.textContent).toContain("bad");
    expect(document.body.textContent).toContain("rel");
  });

  it("pictures from the web are not loaded: only their description is shown", async () => {
    await render("![a cat](https://example.com/cat.png) ![](http://x.test/y.png)");
    expect(q("img")).toBeNull();
    expect(document.body.textContent).toContain("a cat");
    expect(document.body.textContent).toContain("image");
  });

  it("a picture inside the file itself is shown", async () => {
    await render("![dot](data:image/png;base64,iVBORw0KGgo=)");
    expect(q("img")!.getAttribute("alt")).toBe("dot");
  });

  it("which links count as openable", () => {
    for (const ok of ["http://a.co", "HTTPS://a.co/x?y=1", "mailto:a@b.co"]) expect(OPENABLE_LINK.test(ok)).toBe(true);
    for (const no of ["javascript:alert(1)", "file:///x", "data:text/html,x", "ftp://a", "//a.co", "a.co", ""]) expect(OPENABLE_LINK.test(no)).toBe(false);
  });
});
