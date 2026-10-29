import { describe, expect, it } from "vitest";
import { copyFields, moveSelection, searchEntries, toResult, type IndexItem } from "./rank";

const item = (rel: string, over: Partial<IndexItem> = {}): IndexItem => ({
  rel, ext: "login", tags: [], starred: false, updated: 0, host: "", urls: [], ...over,
});

const items = [
  item("Work/GitHub.nqv", { host: "github.com", urls: ["https://github.com/login"], updated: 5 }),
  item("Personal/Gmail.nqv", { host: "mail.google.com", urls: ["https://mail.google.com"], tags: ["email"], updated: 9 }),
  item("Servers/prod box.nqv", { ext: "ssh", host: "prod.example.com", urls: ["prod.example.com"], updated: 1 }),
  item("OpenAI key.nqv", { ext: "secret", host: "OpenAI", urls: ["OpenAI"], starred: true, updated: 2 }),
  item("Git notes.nqv", { ext: "md", updated: 7 }),
].map(toResult);

const names = (q: string) => searchEntries(items, q).map((r) => r.name);

describe("toResult", () => {
  it("derives name, folder and kind", () => {
    const r = toResult(item("Servers/prod box.nqv", { ext: "ssh" }));
    expect(r).toMatchObject({ name: "prod box", folder: "Servers", kind: "ssh" });
    expect(toResult(item("a.nqv", { ext: "md" }))).toMatchObject({ folder: "", kind: "note" });
  });
});

describe("searchEntries", () => {
  it("lists starred first, then most recent, for an empty query", () => {
    expect(names("")).toEqual(["OpenAI key", "Gmail", "Git notes", "GitHub", "prod box"]);
    expect(searchEntries(items, "  ", 2)).toHaveLength(2);
  });

  it("ranks exact and prefix name matches above url / folder matches", () => {
    expect(names("github")[0]).toBe("GitHub");
    expect(names("git")).toEqual(["Git notes", "GitHub"]); // both prefix; newer first
    expect(names("google")).toEqual(["Gmail"]); // url / host
    expect(names("example.com")).toEqual(["prod box"]);
    expect(names("servers")).toEqual(["prod box"]); // folder
  });

  it("matches tags (with or without #) and requires every token", () => {
    expect(names("#email")).toEqual(["Gmail"]);
    expect(names("email")).toEqual(["Gmail"]);
    expect(names("git work")).toEqual(["GitHub"]);
    expect(names("git nothing")).toEqual([]);
  });

  it("is case-insensitive and matches word starts", () => {
    expect(names("BOX")).toEqual(["prod box"]);
    expect(names("key")).toEqual(["OpenAI key"]);
  });
});

describe("moveSelection", () => {
  it("wraps around", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(1, 1, 3)).toBe(2);
    expect(moveSelection(4, 1, 0)).toBe(0);
  });
});

describe("copyFields", () => {
  it("login: password / username", () => {
    const c = copyFields("login", JSON.stringify({ username: "me", password: "pw" }));
    expect(c.main).toEqual({ label: "Password", value: "pw" });
    expect(c.secondary).toEqual({ label: "Username", value: "me" });
  });

  it("ssh: password, else passphrase; username", () => {
    const pw = copyFields("ssh", JSON.stringify({ fields: { password: "p", username: "root" } }));
    expect(pw.main?.value).toBe("p");
    expect(pw.secondary?.value).toBe("root");
    const pp = copyFields("ssh", JSON.stringify({ fields: { passphrase: "pp" } }));
    expect(pp.main).toEqual({ label: "Key passphrase", value: "pp" });
    expect(pp.secondary).toBeNull();
  });

  it("secret: key / env name", () => {
    const c = copyFields("secret", JSON.stringify({ fields: { key: "sk-1", env: "OPENAI_API_KEY" } }));
    expect(c.main).toEqual({ label: "API key", value: "sk-1" });
    expect(c.secondary?.value).toBe("OPENAI_API_KEY");
  });

  it("notes and broken content copy nothing", () => {
    expect(copyFields("md", "# hi")).toEqual({ main: null, secondary: null });
    expect(copyFields("login", "{broken")).toEqual({ main: null, secondary: null });
  });
});

describe("copyFields for the 0.7.0 entry types", () => {
  it("card: copies the number; the cardholder is secondary", () => {
    const c = copyFields("card", JSON.stringify({ fields: { cardholder: "A B", number: "4111111111111111", cvv: "123" } }));
    expect(c.main).toEqual({ label: "Card number", value: "4111111111111111" });
    expect(c.secondary?.value).toBe("A B");
  });

  it("wifi: copies the password; the network name is secondary", () => {
    const c = copyFields("wifi", JSON.stringify({ fields: { ssid: "HomeNet", password: "pw-123" } }));
    expect(c.main?.value).toBe("pw-123");
    expect(c.secondary?.value).toBe("HomeNet");
  });

  it("recovery codes: copies the next unused code", () => {
    const raw = JSON.stringify({ v: 1, kind: "codes", service: "GitHub", codes: [{ code: "aaa", used: true }, { code: "bbb", used: false }, { code: "ccc", used: false }] });
    expect(copyFields("codes", raw).main).toEqual({ label: "Next recovery code", value: "bbb" });
    const used = JSON.stringify({ v: 1, kind: "codes", service: "x", codes: [{ code: "aaa", used: true }] });
    expect(copyFields("codes", used).main).toBeNull();
  });
});
