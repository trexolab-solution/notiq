import { describe, it, expect } from "vitest";
import type { VaultItem } from "./vault";
import {
  allFolders, ancestorsOf, buildTree, canMoveTo, daysUntilPurge, displayName, entryKind, filterItems,
  flattenTree, isSameOrUnder, movedRel, nameError, nameTaken, normalizeTags, parentRel, relativeTime,
  remapPath, renamedRel, starredNodes, tagCounts, toFull, toRel, trashRoots, uniqueName, childNames,
} from "./vaultTree";

const it_ = (rel: string, o: Partial<VaultItem> = {}): VaultItem => ({
  rel, ext: rel.endsWith(".nqv") ? "md" : "", updated: 0, dir: !rel.endsWith(".nqv"),
  tags: [], starred: false, trashed_at: null, ...o,
});

const ITEMS: VaultItem[] = [
  it_("Work", { updated: 5 }),
  it_("Work/AWS.nqv", { ext: "secret", updated: 50, tags: ["cloud", "prod"] }),
  it_("Work/db.nqv", { ext: "ssh", updated: 10, tags: ["prod"] }),
  it_("Work/Old", { updated: 1 }),
  it_("Personal/bank.nqv", { ext: "login", updated: 30, tags: ["Finance"], starred: true }),
  it_("readme.nqv", { updated: 99 }),
  it_("note 10.nqv", { updated: 2 }),
  it_("note 2.nqv", { updated: 3 }),
];

describe("paths", () => {
  it("parent / display name", () => {
    expect(parentRel("a/b/c.nqv")).toBe("a/b");
    expect(parentRel("c.nqv")).toBe("");
    expect(displayName("a/b/My note.nqv")).toBe("My note");
    expect(displayName("a/Folder")).toBe("Folder");
  });
  it("toFull / toRel round-trip with Windows roots", () => {
    const full = toFull("C:\\Users\\me\\Notiq Vault\\", "Work/AWS.nqv");
    expect(full).toBe("C:/Users/me/Notiq Vault/Work/AWS.nqv");
    expect(toRel("C:\\Users\\me\\Notiq Vault", full)).toBe("Work/AWS.nqv");
    expect(toRel("c:/users/me/notiq vault", full)).toBe("Work/AWS.nqv");
    expect(toRel("C:/elsewhere", full)).toBeNull();
  });
  it("isSameOrUnder does not match sibling prefixes", () => {
    expect(isSameOrUnder("r/Work/a.nqv", "r/Work")).toBe(true);
    expect(isSameOrUnder("r/Work", "r/Work/")).toBe(true);
    expect(isSameOrUnder("r/Workshop/a.nqv", "r/Work")).toBe(false);
  });
  it("remapPath handles files and folder prefixes", () => {
    expect(remapPath("r/Work/a.nqv", "r/Work/a.nqv", "r/Work/b.nqv")).toBe("r/Work/b.nqv");
    expect(remapPath("r/Work/sub/a.nqv", "r/Work", "r/Jobs")).toBe("r/Jobs/sub/a.nqv");
    expect(remapPath("r/Workshop/a.nqv", "r/Work", "r/Jobs")).toBeNull();
  });
  it("renamedRel / movedRel", () => {
    expect(renamedRel("Work/AWS.nqv", " Amazon ", false)).toBe("Work/Amazon.nqv");
    expect(renamedRel("Work/Old", "Archive", true)).toBe("Work/Archive");
    expect(renamedRel("a.nqv", "b.nqv", false)).toBe("b.nqv");
    expect(movedRel("Work/AWS.nqv", "Personal")).toBe("Personal/AWS.nqv");
    expect(movedRel("Work/AWS.nqv", "")).toBe("AWS.nqv");
  });
  it("canMoveTo rejects no-ops and cycles", () => {
    expect(canMoveTo("Work/AWS.nqv", "Work")).toBe(false);
    expect(canMoveTo("Work/AWS.nqv", "")).toBe(true);
    expect(canMoveTo("Work", "Work/Old")).toBe(false);
    expect(canMoveTo("Work", "Work")).toBe(false);
    expect(canMoveTo("Work", "Workshop")).toBe(true);
    expect(canMoveTo("readme.nqv", "")).toBe(false);
  });
  it("nameError", () => {
    expect(nameError("  ")).toBeTruthy();
    expect(nameError("a/b")).toBeTruthy();
    expect(nameError("..")).toBeTruthy();
    expect(nameError("Good name")).toBeNull();
  });
  it("uniqueName / nameTaken / childNames", () => {
    expect(uniqueName("New folder", [])).toBe("New folder");
    expect(uniqueName("New folder", ["new folder", "New folder 2"])).toBe("New folder 3");
    expect(childNames(ITEMS, "Work")).toEqual(["AWS", "db", "Old"]);
    expect(nameTaken(ITEMS, "Work", "aws")).toBe(true);
    expect(nameTaken(ITEMS, "Work", "aws", "Work/AWS.nqv")).toBe(false);
    expect(nameTaken(ITEMS, "", "aws")).toBe(false);
  });
  it("ancestorsOf", () => {
    expect(ancestorsOf("a/b/c.nqv")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("c.nqv")).toEqual([]);
  });
});

describe("kinds & tags", () => {
  it("entryKind", () => {
    expect(entryKind({ dir: true, ext: "" })).toBe("folder");
    expect(entryKind({ dir: false, ext: "login" })).toBe("login");
    expect(entryKind({ dir: false, ext: "SSH" })).toBe("ssh");
    expect(entryKind({ dir: false, ext: "secret" })).toBe("secret");
    expect(entryKind({ dir: false, ext: "md" })).toBe("note");
    expect(entryKind({ dir: false, ext: "" })).toBe("note");
  });
  it("normalizeTags trims, strips #, dedupes", () => {
    expect(normalizeTags([" #prod ", "Prod", "", "two  words", "x"])).toEqual(["prod", "two words", "x"]);
  });
  it("tagCounts sorts by count then name, ignores folders", () => {
    const withFolderTag = [...ITEMS, it_("Tagged", { tags: ["prod"] })];
    expect(tagCounts(withFolderTag)).toEqual([
      { tag: "prod", count: 2 }, { tag: "cloud", count: 1 }, { tag: "Finance", count: 1 },
    ]);
  });
});

describe("filterItems", () => {
  const rels = (xs: VaultItem[]) => xs.map((x) => x.rel).sort();

  it("returns everything when not filtering", () => {
    expect(filterItems(ITEMS, { query: " ", tags: [] })).toBe(ITEMS);
  });
  it("matches names case-insensitively and keeps ancestors", () => {
    expect(rels(filterItems(ITEMS, { query: "aws", tags: [] }))).toEqual(["Work", "Work/AWS.nqv"]);
  });
  it("matches tag text through the query", () => {
    expect(rels(filterItems(ITEMS, { query: "finan", tags: [] }))).toEqual(["Personal/bank.nqv"]);
  });
  it("tag filters are AND-ed and case-insensitive", () => {
    expect(rels(filterItems(ITEMS, { query: "", tags: ["PROD"] }))).toEqual(["Work", "Work/AWS.nqv", "Work/db.nqv"]);
    expect(rels(filterItems(ITEMS, { query: "", tags: ["prod", "cloud"] }))).toEqual(["Work", "Work/AWS.nqv"]);
    expect(rels(filterItems(ITEMS, { query: "db", tags: ["cloud"] }))).toEqual([]);
  });
  it("a folder name match brings its subtree", () => {
    expect(rels(filterItems(ITEMS, { query: "work", tags: [] })))
      .toEqual(["Work", "Work/AWS.nqv", "Work/Old", "Work/db.nqv"]);
  });
  it("never searches contents (only names/tags exist here)", () => {
    expect(filterItems(ITEMS, { query: "password123", tags: [] })).toEqual([]);
  });
});

describe("buildTree / flattenTree", () => {
  it("nests, creates implicit folders, sorts folders first + natural name order", () => {
    const tree = buildTree(ITEMS, "name");
    expect(tree.map((n) => n.name)).toEqual(["Personal", "Work", "note 2", "note 10", "readme"]);
    const personal = tree[0];
    expect(personal.dir).toBe(true); // implicit (not listed itself)
    expect(personal.children.map((c) => c.rel)).toEqual(["Personal/bank.nqv"]);
    const work = tree[1];
    expect(work.children.map((c) => c.name)).toEqual(["Old", "AWS", "db"]);
    expect(work.children[1].kind).toBe("secret");
    expect(work.children[1].depth).toBe(1);
  });
  it("sorts by recently modified with folder recency rolled up", () => {
    const tree = buildTree(ITEMS, "modified");
    expect(tree.map((n) => n.name)).toEqual(["Work", "Personal", "readme", "note 2", "note 10"]);
    expect(tree[0].updated).toBe(50);
    expect(tree[0].children.map((c) => c.name)).toEqual(["Old", "AWS", "db"]);
  });
  it("flattens respecting expansion", () => {
    const tree = buildTree(ITEMS, "name");
    expect(flattenTree(tree, () => false).length).toBe(5);
    const rows = flattenTree(tree, (r) => r === "Work");
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      "0:Personal", "0:Work", "1:Old", "1:AWS", "1:db", "0:note 2", "0:note 10", "0:readme",
    ]);
  });
  it("handles 1000 entries quickly", () => {
    const many: VaultItem[] = [];
    for (let f = 0; f < 20; f++) for (let n = 0; n < 50; n++) many.push(it_(`F${f}/n${n}.nqv`, { updated: n }));
    const t0 = performance.now();
    const rows = flattenTree(buildTree(filterItems(many, { query: "n1", tags: [] })), () => true);
    expect(rows.length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("starred / folders", () => {
  it("starredNodes lists starred entries flat", () => {
    expect(starredNodes(ITEMS).map((n) => n.rel)).toEqual(["Personal/bank.nqv"]);
  });
  it("allFolders includes implicit parents", () => {
    expect(allFolders(ITEMS)).toEqual(["Personal", "Work", "Work/Old"]);
  });
});

describe("trash", () => {
  it("shows only top-most trashed entries with child counts, newest first", () => {
    const trash: VaultItem[] = [
      it_("Old", { trashed_at: 100 }),
      it_("Old/a.nqv", { trashed_at: 100 }),
      it_("Old/sub", { trashed_at: 100 }),
      it_("Old/sub/b.nqv", { trashed_at: 100 }),
      it_("x.nqv", { trashed_at: 200, ext: "login" }),
    ];
    const roots = trashRoots(trash);
    expect(roots.map((r) => [r.name, r.childCount, r.kind])).toEqual([["x", 0, "login"], ["Old", 3, "folder"]]);
  });
  it("daysUntilPurge counts down from 30", () => {
    const day = 86_400_000;
    expect(daysUntilPurge(0, 0)).toBe(30);
    expect(daysUntilPurge(0, 29.5 * day)).toBe(1);
    expect(daysUntilPurge(0, 40 * day)).toBe(0);
  });
  it("relativeTime", () => {
    const now = 1_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 d ago");
  });
});
