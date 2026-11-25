import { describe, expect, it } from "vitest";
import { migrateLocalImages, type MigrateDeps } from "./vaultImageMigrate";

const ID1 = "a".repeat(32);
const ID2 = "b".repeat(32);

function deps(files: Record<string, Uint8Array | Error>, opts: { limit?: string } = {}) {
  const added: string[] = [];
  const d: MigrateDeps = {
    resolve: (src) => (src.startsWith("assets/") ? `C:/notes/${src}` : /^[A-Za-z]:[\/]/.test(src) || src.startsWith("/") ? src : null),
    load: async (abs) => { const f = files[abs]; if (!f) throw new Error("missing"); if (f instanceof Error) throw f; return f; },
    add: async (name) => { if (opts.limit) throw new Error(opts.limit); added.push(name); return added.length === 1 ? ID1 : ID2; },
  };
  return { d, added };
}

describe("migrateLocalImages", () => {
  it("moves a relative image next to the note and points the link at the attachment", async () => {
    const { d, added } = deps({ "C:/notes/assets/img-1.png": new Uint8Array([1, 2]) });
    const r = await migrateLocalImages("Hello\n\n![pasted-image](assets/img-1.png)\n", d);
    expect(r.content).toBe(`Hello\n\n![pasted-image](vault-attachment:${ID1})\n`);
    expect(r.moved).toBe(1);
    expect(r.failed).toEqual([]);
    expect(added).toEqual(["img-1.png"]);
  });

  it("stores a file linked twice once", async () => {
    const { d, added } = deps({ "C:/notes/assets/img-1.png": new Uint8Array([1]) });
    const r = await migrateLocalImages("![a](assets/img-1.png) and ![b](assets/img-1.png)", d);
    expect(added).toHaveLength(1);
    expect(r.content).toBe(`![a](vault-attachment:${ID1}) and ![b](vault-attachment:${ID1})`);
    expect(r.moved).toBe(2);
  });

  it("handles absolute Windows paths, <angle> links, encoded spaces and titles", async () => {
    const { d } = deps({ "C:/pics/my photo.jpg": new Uint8Array([1]), "C:/notes/assets/x y.png": new Uint8Array([1]) });
    const r = await migrateLocalImages('![](C:/pics/my%20photo.jpg "Cap") ![](<assets/x y.png>)', d);
    expect(r.content).toBe(`![](vault-attachment:${ID1} "Cap") ![](vault-attachment:${ID2})`);
  });

  it("leaves web, data, blob and vault links and non-image links alone", async () => {
    const { d, added } = deps({});
    const text = `![a](https://x.io/a.png) ![b](data:image/png;base64,AAAA) ![c](vault-attachment:${ID1}) [d](assets/doc.pdf) ![e](assets/readme.txt)`;
    const r = await migrateLocalImages(text, d);
    expect(r.content).toBe(text);
    expect(r.moved).toBe(0);
    expect(r.failed).toEqual([]);
    expect(added).toEqual([]);
  });

  it("leaves images inside code blocks alone", async () => {
    const { d, added } = deps({ "C:/notes/assets/img-1.png": new Uint8Array([1]) });
    const text = "```md\n![x](assets/img-1.png)\n```\n\n![y](assets/img-1.png)";
    const r = await migrateLocalImages(text, d);
    expect(r.content).toBe("```md\n![x](assets/img-1.png)\n```\n\n" + `![y](vault-attachment:${ID1})`);
    expect(added).toHaveLength(1);
  });

  it("keeps a link whose file is missing or unreadable, and says why", async () => {
    const { d } = deps({ "C:/notes/assets/bad.png": new Error("denied") });
    const r = await migrateLocalImages("![a](assets/gone.png) ![b](assets/bad.png) ![c](no-folder.png)", d);
    expect(r.content).toBe("![a](assets/gone.png) ![b](assets/bad.png) ![c](no-folder.png)");
    expect(r.moved).toBe(0);
    expect(r.failed.map((f) => f.src)).toEqual(["assets/gone.png", "assets/bad.png", "no-folder.png"]);
    expect(r.failed[1].reason).toBe("denied");
  });

  it("keeps the link when the vault refuses the file (a limit)", async () => {
    const { d } = deps({ "C:/notes/assets/img-1.png": new Uint8Array([1]) }, { limit: "An entry can have at most 20 attachments" });
    const r = await migrateLocalImages("![a](assets/img-1.png)", d);
    expect(r.content).toBe("![a](assets/img-1.png)");
    expect(r.failed).toEqual([{ src: "assets/img-1.png", reason: "An entry can have at most 20 attachments" }]);
  });
});
