import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The page's content security policy, as the app ships it (src-tauri/tauri.conf.json). */
const csp: string = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app.security.csp;
const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `))?.split(/\s+/).slice(1) ?? null;

describe("content security policy", () => {
  it("lets the page show a PDF from a blob address in a frame (the remote file viewer), and nothing else", () => {
    // Without this the system's PDF viewer is blocked in the shipped app (it is only allowed in development, where no policy applies).
    expect(directive("frame-src")).toEqual(["'self'", "blob:"]);
  });

  it("stays closed otherwise", () => {
    expect(directive("default-src")).toEqual(["'self'"]);
    expect(directive("script-src")).toEqual(["'self'", "blob:"]);
    expect(directive("connect-src")).toEqual(["'self'", "ipc:", "http://ipc.localhost"]);
    expect(csp).not.toMatch(/\*(?![\w.])/); // no wildcard source anywhere
    expect(csp).not.toContain("unsafe-eval");
  });
});
