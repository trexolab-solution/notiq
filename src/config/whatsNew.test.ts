import { describe, expect, it } from "vitest";
import { APP_VERSION } from "./app";
import { WHATS_NEW } from "./whatsNew";

describe("What's New note", () => {
  // The note is a template string: a backtick inside it ends the string and the app stops compiling.
  it("is the note for this version, starts with a heading and ends with the releases link", () => {
    expect(WHATS_NEW.startsWith(`# What's New in Notiq ${APP_VERSION}`)).toBe(true);
    expect(WHATS_NEW).toContain("https://github.com/trexolab-solution/notiq/releases");
  });

  it("has the sections a reader expects and no empty bullet", () => {
    expect(WHATS_NEW.match(/^## /gm)?.length).toBeGreaterThanOrEqual(2);
    expect(WHATS_NEW).not.toMatch(/^- *$/m);
    expect(WHATS_NEW).not.toContain("undefined");
  });

  it("is short enough to read at a glance", () => {
    expect(WHATS_NEW.length).toBeLessThan(3500);
    expect(WHATS_NEW.split("\n").length).toBeLessThan(45);
  });
});
