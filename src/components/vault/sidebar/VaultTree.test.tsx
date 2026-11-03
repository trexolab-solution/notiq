import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTree, flattenTree, starredNodes } from "../../../lib/vaultTree";
import type { VaultItem } from "../../../lib/vault";
import { flattenGrouped } from "../../../lib/vaultSites";
import { VaultTree, isOnControl } from "./VaultTree";
import { TagBar } from "./TagBar";

const item = (rel: string, o: Partial<VaultItem> = {}): VaultItem => ({
  rel, ext: rel.endsWith(".nqv") ? "md" : "", updated: 0, dir: !rel.endsWith(".nqv"),
  tags: [], starred: false, trashed_at: null, ...o,
});

const ITEMS = [
  item("Work"),
  item("Work/AWS prod keys with a very long name indeed.nqv", { ext: "secret", tags: ["prod", "cloud", "aws"] }),
  item("bank.nqv", { ext: "login", starred: true }),
];

const noop = () => {};

describe("VaultTree (static render smoke test)", () => {
  it("renders an accessible tree with starred group, indent, tags and kinds", () => {
    const tree = buildTree(ITEMS);
    const html = renderToStaticMarkup(
      <VaultTree
        rows={flattenTree(tree, () => true)}
        starred={starredNodes(ITEMS)}
        starredOpen
        onStarredOpen={noop}
        isExpanded={() => true}
        selectedKey="t:bank.nqv"
        openRels={new Set(["bank.nqv"])}
        editingKey={null}
        renderEditor={() => null}
        creating={null}
        empty={<p>empty</p>}
        onSelectKey={noop}
        onActivate={noop}
        onToggle={noop}
        onRename={noop}
        onTrash={noop}
        onMenu={noop}
        onMove={noop}
      />,
    );
    expect(html).toContain('role="tree"');
    expect((html.match(/role="treeitem"/g) ?? []).length).toBe(4); // 1 starred + 3 tree rows
    expect(html).toContain('aria-level="2"');
    expect(html).toContain("Starred");
    expect(html).toContain('class="vt-row-tag">+1<');
    expect(html).toContain("k-secret");
    expect(html).toContain("is-open"); // bank.nqv is open in a tab
    expect(html).not.toContain("empty");
  });

  it("shows the empty state when there are no rows", () => {
    const html = renderToStaticMarkup(
      <VaultTree rows={[]} starred={[]} starredOpen onStarredOpen={noop} isExpanded={() => false}
        selectedKey={null} openRels={new Set()} editingKey={null} renderEditor={() => null} creating={null}
        empty={<p>Your vault is empty</p>} onSelectKey={noop} onActivate={noop} onToggle={noop}
        onRename={noop} onTrash={noop} onMenu={noop} onMove={noop} />,
    );
    expect(html).toContain("Your vault is empty");
  });
});

describe("VaultTree site groups", () => {
  const logins = [item("gh1.nqv", { ext: "login" }), item("gh2.nqv", { ext: "login" }), item("one.nqv", { ext: "login" })];
  const siteOf = (n: { rel: string }) => (n.rel.startsWith("gh") ? "github.com" : "x.com");
  const render = (open: boolean) => renderToStaticMarkup(
    <VaultTree
      rows={flattenGrouped(buildTree(logins), () => open, siteOf)}
      subtitles={new Map([["gh1.nqv", "alice"]])}
      starred={[]} starredOpen onStarredOpen={noop} isExpanded={() => open}
      selectedKey={null} openRels={new Set()} editingKey={null} renderEditor={() => null} creating={null}
      empty={<p>empty</p>} onSelectKey={noop} onActivate={noop} onToggle={noop}
      onRename={noop} onTrash={noop} onMenu={noop} onMove={noop} />,
  );

  it("renders a collapsed group row with its count, hiding the members", () => {
    const html = render(false);
    expect((html.match(/role="treeitem"/g) ?? []).length).toBe(2); // group + the lone login
    expect(html).toContain("github.com");
    expect(html).toContain('class="vt-count">2<');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("gh1");
  });

  it("lists the accounts with their username subtitle when expanded", () => {
    const html = render(true);
    expect((html.match(/role="treeitem"/g) ?? []).length).toBe(4);
    expect(html).toContain('class="vt-row-sub">alice<');
    expect(html).toContain('aria-level="2"');
  });
});

describe("VaultTree selection target and row actions", () => {
  const items = [item("Work"), item("Work/key.nqv", { ext: "secret" }), item("bank.nqv", { ext: "login" })];
  const render = (selectedKey: string | null, targetFolder: string) => renderToStaticMarkup(
    <VaultTree
      rows={flattenTree(buildTree(items), () => true)}
      starred={[]} starredOpen onStarredOpen={noop} isExpanded={() => true}
      selectedKey={selectedKey} targetFolder={targetFolder} openRels={new Set()} editingKey={null}
      renderEditor={() => null} creating={null} empty={<p>empty</p>} onSelectKey={noop} onActivate={noop}
      onToggle={noop} onRename={noop} onTrash={noop} onMenu={noop} onMove={noop} />,
  );

  it("marks the folder an entry's New item would go into, but not when that folder is itself selected", () => {
    expect(render("t:Work/key.nqv", "Work")).toContain("is-target");
    expect(render("t:Work", "Work")).not.toContain("is-target");
    expect(render(null, "")).not.toContain("is-target");
    expect(render(null, "")).not.toContain("is-selected");
  });

  it("offers an 'Open in new tab' hover button on entries only", () => {
    const html = render(null, "");
    expect((html.match(/in new tab"/g) ?? []).length).toBe(2); // key.nqv + bank.nqv, not the folder
    expect(html).toContain('aria-label="Open bank in new tab"');
  });
});

describe("isOnControl (empty-space clicks clear the selection)", () => {
  it("treats rows, buttons and fields as controls, anything else as empty space", () => {
    // Minimal Element stand-ins: closest() is all isOnControl uses.
    class FakeEl { constructor(private hit: boolean) {} closest() { return this.hit ? this : null; } }
    vi.stubGlobal("Element", FakeEl);
    expect(isOnControl(new FakeEl(true) as unknown as Element)).toBe(true);
    expect(isOnControl(new FakeEl(false) as unknown as Element)).toBe(false);
    expect(isOnControl(null)).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("TagBar", () => {
  it("marks selected tags and offers Clear", () => {
    const html = renderToStaticMarkup(
      <TagBar tags={[{ tag: "prod", count: 2 }, { tag: "cloud", count: 1 }]} selected={["PROD"]} onToggle={noop} onClear={noop} />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Clear");
  });
});
