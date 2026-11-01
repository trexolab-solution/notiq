import { describe, it, expect } from "vitest";
import type { VaultItem } from "./vault";
import { buildTree, filterItems } from "./vaultTree";
import {
  flattenGrouped, groupSiblings, isGroupRow, searchTextOf, siteDomain, siteInfoOf, siteMatchReason, type LoginSite,
} from "./vaultSites";

const item = (rel: string, o: Partial<VaultItem> = {}): VaultItem => ({
  rel, ext: "login", updated: 0, dir: false, tags: [], starred: false, trashed_at: null, attachments: 0, history: 0, ...o,
});
const folder = (rel: string): VaultItem => item(rel, { dir: true, ext: "" });

const site = (url: string, username = "", urls: string[] = []): LoginSite => siteInfoOf({ url, urls, username });

describe("siteDomain", () => {
  it("uses the registrable domain", () => {
    expect(siteDomain("https://gist.github.com/x")).toBe("github.com");
    expect(siteDomain("login.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteDomain("GitHub.com")).toBe("github.com");
  });
  it("falls back to the host for IPs and localhost, null when empty", () => {
    expect(siteDomain("http://192.168.1.1:8080")).toBe("192.168.1.1");
    expect(siteDomain("localhost:3000")).toBe("localhost");
    expect(siteDomain("")).toBeNull();
    expect(siteDomain("   ")).toBeNull();
  });
});

describe("siteInfoOf / search", () => {
  it("keeps hosts and username only", () => {
    const s = siteInfoOf({ url: "https://github.com/login", urls: ["gitlab.com", "https://github.com"], username: " me@x.io " });
    expect(s).toEqual({ domain: "github.com", hosts: ["github.com", "gitlab.com"], username: "me@x.io" });
    expect(JSON.stringify(s)).not.toMatch(/password/i);
  });
  it("searchTextOf lists hosts, domain and lower-cased username", () => {
    expect(searchTextOf(site("https://gist.github.com", "Me@X.io"))).toEqual(["gist.github.com", "github.com", "me@x.io"]);
    expect(searchTextOf(undefined)).toEqual([]);
  });
  it("siteMatchReason names the site or username that matched", () => {
    const s = site("github.com", "alice", ["gitlab.com"]);
    expect(siteMatchReason(s, "github")).toBe("github.com");
    expect(siteMatchReason(s, "GITLAB.com")).toBe("gitlab.com");
    expect(siteMatchReason(s, "alic")).toBe("alice");
    expect(siteMatchReason(s, "zzz")).toBeNull();
    expect(siteMatchReason(s, "")).toBeNull();
    expect(siteMatchReason(undefined, "github")).toBeNull();
  });
  it("filterItems finds logins by site, other site and username", () => {
    const items = [item("a.nqv"), item("b.nqv"), item("c.nqv")];
    const sites = new Map<string, LoginSite>([
      ["a.nqv", site("https://github.com", "alice")],
      ["b.nqv", site("example.com", "bob", ["github.com"])],
      ["c.nqv", site("example.org")],
    ]);
    const extra = (i: VaultItem) => searchTextOf(sites.get(i.rel.toLowerCase()));
    const names = (q: string) => filterItems(items, { query: q, tags: [], extra }).map((i) => i.rel);
    expect(names("github")).toEqual(["a.nqv", "b.nqv"]);
    expect(names("github.com")).toEqual(["a.nqv", "b.nqv"]);
    expect(names("bob")).toEqual(["b.nqv"]);
    expect(names("nothing")).toEqual([]);
    // without the site index nothing matches (names only)
    expect(filterItems(items, { query: "github", tags: [] })).toEqual([]);
  });
});

const nodes = (items: VaultItem[]) => buildTree(items);
const domains = new Map<string, string | null>();
const siteOf = (n: { rel: string }) => domains.get(n.rel) ?? null;

describe("groupSiblings", () => {
  it("groups 2+ logins of one domain, keeps a lone login as a row", () => {
    domains.clear();
    domains.set("a.nqv", "github.com"); domains.set("b.nqv", "github.com"); domains.set("c.nqv", "gitlab.com");
    const slots = groupSiblings(nodes([item("a.nqv"), item("b.nqv"), item("c.nqv")]), "", siteOf);
    expect(slots).toHaveLength(2);
    const g = (slots[0] as { group: { domain: string; members: { rel: string }[]; rel: string } }).group;
    expect(g.domain).toBe("github.com");
    expect(g.members.map((m) => m.rel)).toEqual(["a.nqv", "b.nqv"]);
    expect(g.rel).toBe("@site:github.com");
    expect("node" in slots[1] && slots[1].node.rel).toBe("c.nqv");
  });
  it("needs at least 2 (threshold) and respects a custom one", () => {
    domains.clear(); domains.set("a.nqv", "github.com"); domains.set("b.nqv", "github.com");
    const n = nodes([item("a.nqv"), item("b.nqv")]);
    expect(groupSiblings(n, "", siteOf, 3).every((s) => "node" in s)).toBe(true);
    expect(groupSiblings(n, "", siteOf, 2)).toHaveLength(1);
  });
  it("leaves entries without a URL, non-logins and folders alone", () => {
    domains.clear(); domains.set("a.nqv", "github.com"); domains.set("n.nqv", "github.com");
    const slots = groupSiblings(
      nodes([item("a.nqv"), item("n.nqv", { ext: "md" }), item("nourl.nqv"), item("nourl2.nqv"), folder("F")]), "", siteOf);
    expect(slots.every((s) => "node" in s)).toBe(true);
  });
  it("places the group where its first member sorts", () => {
    domains.clear(); domains.set("b.nqv", "x.com"); domains.set("d.nqv", "x.com");
    const slots = groupSiblings(nodes([item("a.nqv"), item("b.nqv"), item("c.nqv"), item("d.nqv")]), "", siteOf);
    expect(slots.map((s) => ("group" in s ? "G" : s.node.rel))).toEqual(["a.nqv", "G", "c.nqv"]);
  });
});

describe("flattenGrouped", () => {
  const items = [
    folder("Work"), folder("Home"),
    item("Work/gh1.nqv"), item("Work/gh2.nqv"), item("Work/gh3.nqv"), item("Work/solo.nqv"),
    item("Home/gh.nqv"), item("Home/other.nqv"),
    item("root.nqv"),
  ];
  const setup = () => {
    domains.clear();
    for (const r of ["Work/gh1.nqv", "Work/gh2.nqv", "Work/gh3.nqv", "Home/gh.nqv", "root.nqv"]) domains.set(r, "github.com");
    domains.set("Work/solo.nqv", "gitlab.com");
  };
  const label = (rows: ReturnType<typeof flattenGrouped>) =>
    rows.map((r) => (isGroupRow(r) ? `${r.depth}:G(${r.group.domain},${r.group.members.length})` : `${r.depth}:${r.node.rel}`));

  it("groups per folder, never across folders", () => {
    setup();
    const rows = flattenGrouped(nodes(items), () => true, siteOf);
    expect(label(rows)).toEqual([
      "0:Home",
      "1:Home/gh.nqv", "1:Home/other.nqv",
      "0:Work",
      "1:G(github.com,3)", "2:Work/gh1.nqv", "2:Work/gh2.nqv", "2:Work/gh3.nqv",
      "1:Work/solo.nqv",
      "0:root.nqv",
    ]);
  });
  it("hides members while the group is collapsed; expansion is keyed by the group rel", () => {
    setup();
    const open = new Set(["Work"]);
    const rows = flattenGrouped(nodes(items), (r) => open.has(r), siteOf);
    expect(label(rows)).toContain("1:G(github.com,3)");
    expect(label(rows)).not.toContain("2:Work/gh1.nqv");
    open.add("Work/@site:github.com");
    const rows2 = flattenGrouped(nodes(items), (r) => open.has(r), siteOf);
    const g = rows2.find(isGroupRow)!;
    expect(g.group.rel).toBe("Work/@site:github.com");
    expect(rows2.filter((r) => !isGroupRow(r) && r.inGroup === g.group.rel)).toHaveLength(3);
  });
  it("does not group when switched off", () => {
    setup();
    expect(flattenGrouped(nodes(items), () => true, null).some(isGroupRow)).toBe(false);
  });
});
