import { describe, expect, it } from "vitest";
import { attachmentKind, previewMode } from "./attachmentKinds";

describe("attachmentKind", () => {
  it("goes by extension first, then mime", () => {
    expect(attachmentKind("Scan.JPG")).toBe("image");
    expect(attachmentKind("id_ed25519.pub")).toBe("key");
    expect(attachmentKind("archive.tar.gz")).toBe("archive");
    expect(attachmentKind("noext", "text/plain")).toBe("text");
    expect(attachmentKind("noext")).toBe("other");
  });
});

describe("previewMode", () => {
  it("opens images and text-like files in the app, nothing else", () => {
    expect(previewMode("a.png", "image/png")).toBe("image");
    expect(previewMode("notes.md")).toBe("text");
    expect(previewMode("cfg.json")).toBe("text");
    expect(previewMode("key.pem")).toBe("text");
    expect(previewMode("store.p12")).toBeNull();
    expect(previewMode("doc.pdf", "application/pdf")).toBeNull();
    expect(previewMode("x.zip")).toBeNull();
  });
});
