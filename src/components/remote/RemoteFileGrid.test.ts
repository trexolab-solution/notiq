import { describe, expect, it } from "vitest";
import { fileIconFor } from "./RemoteFileGrid";

describe("grid icons", () => {
  it("picks an icon by kind and extension", () => {
    expect(fileIconFor({ name: "src", kind: "dir" })).toBe("folder");
    expect(fileIconFor({ name: "Photo.PNG", kind: "file" })).toBe("image");
    expect(fileIconFor({ name: "deploy.sh", kind: "file" })).toBe("code");
    expect(fileIconFor({ name: "backup.tar.gz", kind: "file" })).toBe("archive");
    expect(fileIconFor({ name: "notes.md", kind: "file" })).toBe("text");
    expect(fileIconFor({ name: "song.mp3", kind: "file" })).toBe("audio");
    expect(fileIconFor({ name: "clip.mp4", kind: "file" })).toBe("video");
    expect(fileIconFor({ name: "Makefile", kind: "file" })).toBe("file");
    expect(fileIconFor({ name: ".bashrc", kind: "file" })).toBe("file");
  });
});
