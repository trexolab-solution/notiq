import { describe, expect, it } from "vitest";
import {
  cleanName, detectDelimiter, detectFormat, executeImport, guessMapping, parseCsv, parseImport, planCounts, planImport,
  targetFolder, toImportRows, type ImportIO, type PlanOptions,
} from "./csvImport";
import { parseLogin } from "./loginEntry";
import type { VaultItem } from "./vault";

const item = (rel: string, dir = false): VaultItem =>
  ({ rel, ext: dir ? "" : "login", updated: 0, dir, tags: [], starred: false, trashed_at: null, attachments: 0, history: 0 });

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, embedded newlines, CRLF and a BOM", () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","multi\r\nline"\r\n\r\n1,2,3';
    expect(parseCsv(text)).toEqual([["a", "b", "c"], ["x, y", 'say "hi"', "multi\r\nline"], ["1", "2", "3"]]);
  });
  it("detects semicolon and tab delimiters", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter('"a;b",c,d')).toBe(",");
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("keeps empty fields and a trailing row without newline", () => {
    expect(parseCsv("a,,c\n,,")).toEqual([["a", "", "c"], ["", "", ""]]);
  });
});

describe("detectFormat", () => {
  it("recognises Chrome, Bitwarden and KeePass headers", () => {
    expect(detectFormat(["name", "url", "username", "password", "note"]).format).toBe("chrome");
    expect(detectFormat(["folder", "favorite", "type", "name", "notes", "fields", "reprompt", "login_uri",
      "login_username", "login_password", "login_totp"]).format).toBe("bitwarden");
    expect(detectFormat(["Account", "Login Name", "Password", "Web Site", "Comments"]).format).toBe("keepass");
  });
  it("guesses a mapping for other CSVs", () => {
    const m = guessMapping(["Title", "E-mail", "Password", "Website", "Group"]);
    expect(m).toMatchObject({ title: 0, username: 1, password: 2, url: 3, folder: 4, notes: -1 });
    expect(detectFormat(["url", "username", "password", "httpRealm"]).format).toBe("generic");
  });
});

describe("toImportRows", () => {
  it("reads Chrome rows", () => {
    const p = parseImport("name,url,username,password,note\nGitHub,https://github.com/login,me,pw1,hello\n,,,,\n");
    const { rows, skipped } = toImportRows(p);
    expect(rows).toEqual([{ line: 2, title: "GitHub", url: "https://github.com/login", urls: [], username: "me",
      password: "pw1", notes: "hello", folder: "", totp: "" }]);
    expect(skipped).toEqual([{ line: 3, reason: "Empty row" }]);
  });
  it("reads Bitwarden rows: skips non-logins, splits URIs, keeps folder, TOTP and fields", () => {
    const csv = [
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
      'Work,,login,Mail,n,"pin: 1",0,"https://mail.example.com,https://example.com",me,pw,JBSWY3DP',
      ",,note,Secret note,text,,,,,,",
    ].join("\n");
    const { rows, skipped } = toImportRows(parseImport(csv));
    expect(rows[0]).toMatchObject({ folder: "Work", url: "https://mail.example.com", urls: ["https://example.com"],
      totp: "JBSWY3DP", notes: "n\n\npin: 1" });
    expect(skipped).toEqual([{ line: 3, reason: "Not a login (note)" }]);
  });
  it("reads KeePass rows", () => {
    const csv = '"Account","Login Name","Password","Web Site","Comments"\n"Bank","joe","s3cr3t","bank.example.com","x"';
    expect(toImportRows(parseImport(csv)).rows[0]).toMatchObject({ title: "Bank", username: "joe", url: "bank.example.com" });
  });
});

describe("planImport", () => {
  const rows = toImportRows(parseImport([
    "name,url,username,password",
    "GitHub,https://github.com,me,new",
    "GitHub,https://github.com,other,x",
    "Bad/Name:?,https://a.example.com,u,p",
    ",https://b.example.com,u,p",
    "Dup,https://dup.example.com,u,p1",
    "Dup,https://dup.example.com,U,p2",
  ].join("\n"))).rows;
  const base: PlanOptions = {
    policy: "skip", baseFolder: "Imported", useSourceFolders: true,
    items: [item("Imported", true), item("Imported/GitHub.nqv")],
    existing: [{ rel: "Logins/GitHub.nqv", path: "/r/Logins/GitHub.nqv", entry: { url: "https://github.com", urls: [], username: "ME", password: "old" } }],
  };

  it("skips duplicates (same host + username) with policy skip", () => {
    const s = planImport(rows, base);
    expect(s.map((x) => x.action)).toEqual(["skip", "create", "create", "create", "create", "skip"]);
    expect(s[1].rel).toBe("Imported/GitHub 2.nqv"); // unique name
    expect(s[2].rel).toBe("Imported/Bad Name.nqv"); // sanitised
    expect(s[3].rel).toBe("Imported/b.example.com.nqv"); // host fallback
    expect(s[5].reason).toBe("Duplicate row in this file");
  });
  it("updates passwords with policy update and merges duplicates in the file", () => {
    const s = planImport(rows, { ...base, policy: "update" });
    expect(s[0]).toMatchObject({ action: "update", path: "/r/Logins/GitHub.nqv" });
    expect(s[5].action).toBe("skip");
    expect(s[4].row.password).toBe("p2");
    const same = planImport([{ ...rows[0], password: "old" }], { ...base, policy: "update" });
    expect(same[0]).toMatchObject({ action: "skip", reason: "Same password already saved" });
  });
  it("keeps both with policy keep", () => {
    expect(planCounts(planImport(rows, { ...base, policy: "keep" }))).toEqual({ create: 6, update: 0, skip: 0 });
  });
  it("maps source folders under the base folder", () => {
    expect(targetFolder("Imported", "Work/Email")).toBe("Imported/Work/Email");
    expect(targetFolder("", "a:b")).toBe("a b");
    expect(targetFolder("Imported", "")).toBe("Imported");
    expect(cleanName("..hidden")).toBe("hidden");
  });
});

describe("executeImport", () => {
  it("creates folders once (parents first), writes entries, updates and records failures", async () => {
    const calls: string[] = [];
    const written = new Map<string, string>();
    const io: ImportIO = {
      mkdir: async (rel) => { calls.push(`mkdir ${rel}`); },
      create: async (rel, content) => {
        if (rel.includes("Fail")) throw new Error("disk full");
        written.set(rel, content);
      },
      updatePassword: async (path) => { calls.push(`update ${path}`); },
      yieldToUi: async () => { calls.push("yield"); },
    };
    const rows = toImportRows(parseImport([
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
      "Work/Mail,,login,A,,,,https://a.example.com,u,p,",
      "Work/Mail,,login,B,,,,https://b.example.com,u,p,",
      ",,login,Fail,,,,https://c.example.com,u,p,",
    ].join("\n"))).rows;
    const steps = planImport(rows, { policy: "keep", baseFolder: "Imported", useSourceFolders: true, items: [item("Imported", true)], existing: [] });
    const progress: number[] = [];
    const res = await executeImport(steps, ["Imported"], io, (d) => progress.push(d), 2);
    expect(res).toMatchObject({ created: 2, updated: 0, skipped: 0, aborted: false });
    expect(res.failed).toEqual([{ line: 4, name: "Fail", error: "disk full" }]);
    expect(calls.filter((c) => c.startsWith("mkdir"))).toEqual(["mkdir Imported/Work", "mkdir Imported/Work/Mail"]);
    expect(calls).toContain("yield");
    expect(progress.at(-1)).toBe(3);
    const a = parseLogin(written.get("Imported/Work/Mail/A.nqv")!);
    expect(a).toMatchObject({ title: "A", url: "https://a.example.com", username: "u", password: "p" });
  });
  it("stops when shouldContinue turns false", async () => {
    const rows = toImportRows(parseImport("name,url,username,password\na,x.com,u,p\nb,y.com,u,p")).rows;
    const steps = planImport(rows, { policy: "keep", baseFolder: "", useSourceFolders: false, items: [], existing: [] });
    const res = await executeImport(steps, [], {
      mkdir: async () => {}, create: async () => {}, updatePassword: async () => {}, shouldContinue: () => false,
    });
    expect(res.aborted).toBe(true);
    expect(res.created).toBe(0);
  });
  it("handles 5000 rows", async () => {
    const lines = ["name,url,username,password"];
    for (let i = 0; i < 5000; i++) lines.push(`Site ${i},https://s${i}.example.com,u${i},p${i}`);
    const rows = toImportRows(parseImport(lines.join("\n"))).rows;
    const steps = planImport(rows, { policy: "skip", baseFolder: "Imported", useSourceFolders: false, items: [], existing: [] });
    let yields = 0;
    const res = await executeImport(steps, [], {
      mkdir: async () => {}, create: async () => {}, updatePassword: async () => {}, yieldToUi: async () => { yields++; },
    });
    expect(res.created).toBe(5000);
    expect(yields).toBeGreaterThan(100);
  });
});
