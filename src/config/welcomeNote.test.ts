import { beforeEach, describe, expect, it, vi } from "vitest";

const BS = String.fromCharCode(92); // a backslash
const winPath = (...parts: string[]) => parts.join(BS);

const resolveResource = vi.fn(async (p: string): Promise<string> => winPath("C:", "Program Files", "Notiq", ...p.split("/")));
vi.mock("@tauri-apps/api/path", () => ({ resolveResource: (p: string) => resolveResource(p) }));

const { buildWelcomeNote, loadWelcomeImages, SITE_URL, REPO_URL } = await import("./welcomeNote");

beforeEach(() => { resolveResource.mockClear(); });

describe("loadWelcomeImages", () => {
  it("maps each screenshot link to a plain absolute path", async () => {
    const imgs = await loadWelcomeImages();
    expect(Object.keys(imgs!).sort()).toEqual(["welcome/editor.jpg", "welcome/login.jpg", "welcome/ssh.jpg"]);
    expect(imgs!["welcome/ssh.jpg"]).toBe("C:/Program Files/Notiq/welcome/ssh.jpg");
  });

  it("drops the extended-length prefix Windows adds", async () => {
    resolveResource.mockImplementation(async (p) => BS + BS + "?" + BS + winPath("C:", "App", ...p.split("/")));
    expect((await loadWelcomeImages())!["welcome/login.jpg"]).toBe("C:/App/welcome/login.jpg");
  });

  it("is null when the files can't be found", async () => {
    resolveResource.mockRejectedValueOnce(new Error("no resource"));
    expect(await loadWelcomeImages()).toBeNull();
  });
});

describe("buildWelcomeNote", () => {
  const imgs = { "welcome/editor.jpg": "/a", "welcome/login.jpg": "/b", "welcome/ssh.jpg": "/c" };

  it("links the website, downloads, issues and privacy page", () => {
    const md = buildWelcomeNote(null);
    for (const url of [SITE_URL, `${REPO_URL}/releases/latest`, `${REPO_URL}/issues`, `${SITE_URL}privacy.html`]) {
      expect(md).toContain(`](${url})`);
    }
  });

  it("includes the three screenshots when they are available", () => {
    const md = buildWelcomeNote(imgs);
    expect(md.match(/!\[[^\]]+\]\(welcome\/(editor|login|ssh)\.jpg\)/g)).toHaveLength(3);
  });

  it("has no broken image links when they are not", () => {
    expect(buildWelcomeNote(null)).not.toContain("![");
  });

  it("covers the vault, the SSH servers and the editor", () => {
    const md = buildWelcomeNote(null);
    expect(md).toMatch(/Secure Vault/);
    expect(md).toMatch(/SSH \/ server/);
    expect(md).toMatch(/Markdown/);
  });
});
