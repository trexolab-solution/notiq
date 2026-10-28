import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTree, flattenTree, starredNodes } from "../../../lib/vaultTree";
import type { VaultItem } from "../../../lib/vault";
import { VaultTree } from "./VaultTree";
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

describe("TagBar", () => {
  it("marks selected tags and offers Clear", () => {
    const html = renderToStaticMarkup(
      <TagBar tags={[{ tag: "prod", count: 2 }, { tag: "cloud", count: 1 }]} selected={["PROD"]} onToggle={noop} onClear={noop} />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Clear");
  });
});
