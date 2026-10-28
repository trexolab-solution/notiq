import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownAZ, Clock, FolderPlus, Lock, Search, Trash2, X } from "lucide-react";
import { useAppStore } from "../../../store";
import { isVaultPath, type VaultItem } from "../../../lib/vault";
import { DEFAULT_ENTRY_NAME, type NewEntryKind } from "../../../lib/vaultCreate";
import {
  allFolders, ancestorsOf, buildTree, childNames, displayName, entryKind, filterItems, flattenTree, isFiltering,
  isSameOrUnder, matchesFilter, nameError, nameTaken, parentRel, starredNodes, tagCounts, toRel, trashRoots, uniqueName,
  type TreeNode,
} from "../../../lib/vaultTree";
import { ContextMenu } from "../../ui/ContextMenu";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import * as A from "./actions";
import { useExpanded, useSortMode, useStarredOpen } from "./prefs";
import { PanelHeader } from "./PanelHeader";
import { NewEntryMenu } from "./NewEntryMenu";
import { TagBar } from "./TagBar";
import { CreateRow, VaultTree, starKey, treeKey } from "./VaultTree";
import { InlineNameInput } from "./InlineNameInput";
import { TagEditor } from "./TagEditor";
import { MoveDialog } from "./MoveDialog";
import { TrashView } from "./TrashView";
import { buildMenu, type MenuHandlers } from "./menuItems";

interface Props {
  root: string;
  items: VaultItem[];
  trash: VaultItem[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Extra footer content (storage folder row). */
  footer: ReactNode;
}

type Creating = { parent: string; kind: NewEntryKind | "folder"; suggested: string };
type Menu = { x: number; y: number; node: TreeNode | null };

const relOfKey = (key: string | null) => (key ? key.slice(2) : null);

/** The unlocked vault: toolbar, search, tag filter, tree, trash, and every entry action. */
export function VaultExplorer({ root, items, trash, loading, error, reload, footer }: Props) {
  const { expanded, toggle, expandAll, remap } = useExpanded();
  const [sort, setSort] = useSortMode();
  const [starredOpen, setStarredOpen] = useStarredOpen();

  const [query, setQuery] = useState("");
  const [selTags, setSelTags] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [tagEdit, setTagEdit] = useState<TreeNode | null>(null);
  const [moving, setMoving] = useState<TreeNode | null>(null);
  const [confirmTrash, setConfirmTrash] = useState<TreeNode | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const treeWrapRef = useRef<HTMLDivElement>(null);

  // Open tabs, as a stable string so typing in an editor doesn't re-render the tree.
  const openPathsKey = useAppStore((s) =>
    s.tabs.filter((t) => isVaultPath(t.filePath)).map((t) => t.filePath).join("\n"));
  const openRels = useMemo(() => {
    const set = new Set<string>();
    for (const p of openPathsKey ? openPathsKey.split("\n") : []) {
      const r = root ? toRel(root, p) : null;
      if (r) set.add(r.toLowerCase());
    }
    return set;
  }, [openPathsKey, root]);

  // ── derived tree ───────────────────────────────────────────────────────────
  const filter = useMemo(() => ({ query, tags: selTags }), [query, selTags]);
  const filtering = isFiltering(filter);
  const filtered = useMemo(() => filterItems(items, filter), [items, filter]);
  const tree = useMemo(() => buildTree(filtered, sort), [filtered, sort]);
  const isExpanded = useCallback((rel: string) => filtering || expanded.has(rel), [filtering, expanded]);
  const rows = useMemo(() => flattenTree(tree, isExpanded), [tree, isExpanded]);
  const starred = useMemo(
    () => starredNodes(filtering ? items.filter((i) => matchesFilter(i, filter)) : items, sort),
    [filtering, filter, items, sort],
  );
  const tags = useMemo(() => tagCounts(items), [items]);
  const folders = useMemo(() => allFolders(items), [items]);
  const trashCount = useMemo(() => trashRoots(trash).length, [trash]);

  // Drop tag filters for tags that no longer exist.
  useEffect(() => {
    setSelTags((sel) => {
      const next = sel.filter((t) => tags.some((x) => x.tag.toLowerCase() === t.toLowerCase()));
      return next.length === sel.length ? sel : next;
    });
  }, [tags]);

  // Forget a selection whose entry disappeared (trashed, renamed elsewhere, …).
  const byRel = useMemo(() => new Map(items.map((i) => [i.rel.toLowerCase(), i])), [items]);
  useEffect(() => {
    const rel = relOfKey(selectedKey);
    if (rel && !byRel.has(rel.toLowerCase()) && !folders.some((f) => f.toLowerCase() === rel.toLowerCase())) {
      setSelectedKey(null);
    }
  }, [byRel, folders, selectedKey]);

  const selectedRel = relOfKey(selectedKey);
  const selectedItem = selectedRel ? byRel.get(selectedRel.toLowerCase()) : undefined;
  const selectedIsDir = selectedRel ? (selectedItem ? selectedItem.dir : folders.includes(selectedRel)) : false;
  /** Folder new things go into: the selected folder, or the selected note's folder. */
  const targetFolder = selectedRel ? (selectedIsDir ? selectedRel : parentRel(selectedRel)) : "";

  // ── helpers ────────────────────────────────────────────────────────────────
  const reveal = useCallback((rel: string, select = true) => {
    const anc = ancestorsOf(rel);
    if (anc.length) expandAll(anc);
    if (select) setSelectedKey(treeKey(rel));
  }, [expandAll]);

  const focusTreeSoon = () => requestAnimationFrame(() => {
    treeWrapRef.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus({ preventScroll: true });
  });

  const startCreate = useCallback((kind: NewEntryKind | "folder", parent: string) => {
    setShowTrash(false);
    setQuery(""); setSelTags([]);
    if (parent) { expandAll([...ancestorsOf(parent), parent]); }
    const base = kind === "folder" ? "New folder" : DEFAULT_ENTRY_NAME[kind];
    setEditingKey(null);
    setCreating({ parent, kind, suggested: uniqueName(base, childNames(items, parent)) });
  }, [expandAll, items]);

  const validateIn = (folder: string, except?: string) => (name: string) =>
    nameError(name) ?? (nameTaken(items, folder, name, except) ? "That name is already used here" : null);

  // ── actions ────────────────────────────────────────────────────────────────
  const activate = useCallback((node: TreeNode, key: string) => {
    if (node.dir) {
      if (key.startsWith("s:")) { reveal(node.rel); toggle(node.rel, true); focusTreeSoon(); }
      else toggle(node.rel);
      return;
    }
    void A.openEntry(root, node.rel);
  }, [reveal, root, toggle]);

  const openMenu = useCallback((key: string | null, node: TreeNode | null, x: number, y: number) => {
    if (key) setSelectedKey(key);
    setMenu({ x, y, node });
  }, []);

  const askTrash = useCallback((node: TreeNode) => {
    if (node.dir) { setConfirmTrash(node); return; }
    void A.trashEntry(root, node.rel, false);
  }, [root]);

  const doMove = useCallback(async (rel: string, dest: string) => {
    const to = await A.moveEntry(root, items, rel, dest);
    if (!to) return;
    remap(rel, to);
    if (dest) expandAll([...ancestorsOf(dest), dest]);
    setSelectedKey(treeKey(to));
  }, [expandAll, items, remap, root]);

  const handlers: MenuHandlers = {
    open: (n) => void A.openEntry(root, n.rel),
    rename: (n) => {
      // Rename happens in the tree row (a starred row edits in place too).
      const key = selectedKey && relOfKey(selectedKey) === n.rel ? selectedKey : treeKey(n.rel);
      if (key.startsWith("t:")) reveal(n.rel, false);
      setSelectedKey(key);
      setCreating(null);
      setEditingKey(key);
    },
    tags: (n) => setTagEdit(n),
    star: (n) => void A.setStarred(root, n.rel, !n.starred),
    duplicate: async (n) => {
      const rel = await A.duplicateEntry(root, n.rel);
      if (rel) reveal(rel);
    },
    move: (n) => setMoving(n),
    trash: askTrash,
    create: startCreate,
    sort: setSort,
    expandAll: () => expandAll(folders),
    collapseAll: () => { for (const f of expanded) toggle(f, false); },
  };

  const renderEditor = (node: TreeNode) => (
    <InlineNameInput
      initial={node.name}
      label={`Rename ${node.name}`}
      validate={validateIn(parentRel(node.rel), node.rel)}
      onCancel={() => { setEditingKey(null); focusTreeSoon(); }}
      onCommit={async (name) => {
        const to = await A.renameEntry(root, items, node.rel, node.dir, name);
        if (!to) return false;
        if (node.dir) remap(node.rel, to);
        const prefix = editingKey?.startsWith("s:") ? "s:" : "t:";
        setEditingKey(null);
        setSelectedKey(prefix + to);
        focusTreeSoon();
        return true;
      }}
    />
  );

  const createRow = creating && (
    <CreateRow
      key={`create:${creating.parent}:${creating.kind}`}
      depth={creating.parent ? creating.parent.split("/").length : 0}
      kind={creating.kind === "folder" ? "folder" : entryKind({ dir: false, ext: creating.kind === "note" ? "md" : creating.kind })}
    >
      <InlineNameInput
        isNew
        initial={creating.suggested}
        label={creating.kind === "folder" ? "New folder name" : "New entry name"}
        validate={validateIn(creating.parent)}
        onCancel={() => { setCreating(null); focusTreeSoon(); }}
        onCommit={async (name) => {
          const c = creating;
          const rel = c.kind === "folder"
            ? await A.createFolder(root, items, c.parent, name)
            : await A.createEntry(root, items, c.kind, c.parent, name);
          if (!rel) return false;
          setCreating(null);
          setSelectedKey(treeKey(rel));
          if (c.kind === "folder") focusTreeSoon();
          return true;
        }}
      />
    </CreateRow>
  );

  const emptyState = loading ? null : error ? (
    <div className="vt-empty" role="alert">
      <div className="vt-empty-title text-[var(--color-danger)]">Couldn't read the vault</div>
      <div className="mb-2 break-words">{error}</div>
      <button type="button" className="vt-link" onClick={() => void reload()}>Try again</button>
    </div>
  ) : filtering ? (
    <div className="vt-empty">
      <div className="vt-empty-title">No matches</div>
      Only names and tags are searched — contents stay encrypted.
      <div className="mt-2">
        <button type="button" className="vt-link" onClick={() => { setQuery(""); setSelTags([]); }}>Clear search and tags</button>
      </div>
    </div>
  ) : (
    <div className="vt-empty">
      <div className="vt-empty-title">Your vault is empty</div>
      Keep notes, logins, SSH servers and API keys here, encrypted with your master password.
      <div className="mt-2 flex flex-col items-center gap-1">
        <button type="button" className="vt-link" onClick={() => startCreate("note", "")}>New secure note</button>
        <button type="button" className="vt-link" onClick={() => startCreate("login", "")}>New login</button>
        <button type="button" className="vt-link" onClick={() => startCreate("folder", "")}>New folder</button>
      </div>
    </div>
  );

  const targetLabel = targetFolder ? displayName(targetFolder) : "Vault";
  const confirmCount = confirmTrash
    ? items.filter((i) => i.rel !== confirmTrash.rel && isSameOrUnder(i.rel, confirmTrash.rel)).length
    : 0;

  return (
    <>
      <PanelHeader
        unlocked
        actions={
          <>
            <NewEntryMenu targetLabel={targetLabel} onPick={(k) => startCreate(k, targetFolder)} />
            <button type="button" className="vt-icon-btn" title={`New folder in ${targetLabel}`} aria-label="New folder"
                    onClick={() => startCreate("folder", targetFolder)}>
              <FolderPlus size={14} />
            </button>
            <button
              type="button"
              className="vt-icon-btn"
              title={sort === "name" ? "Sorted by name — switch to recently modified" : "Sorted by recently modified — switch to name"}
              aria-label={sort === "name" ? "Sort by recently modified" : "Sort by name"}
              onClick={() => setSort(sort === "name" ? "modified" : "name")}
            >
              {sort === "name" ? <ArrowDownAZ size={14} /> : <Clock size={14} />}
            </button>
            <button type="button" className="vt-icon-btn" title="Lock vault now" aria-label="Lock vault now"
                    onClick={() => void useAppStore.getState().lockVault()}>
              <Lock size={13} />
            </button>
          </>
        }
      />

      {showTrash ? (
        <TrashView
          trash={trash}
          onBack={() => setShowTrash(false)}
          onRestore={(rel) => A.restoreEntry(root, rel)}
          onPurge={(rel) => A.purgeEntry(root, rel)}
          onEmpty={A.emptyTrash}
        />
      ) : (
        <>
          <label className="vt-search">
            <Search size={13} aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Search names and tags"
              aria-label="Search vault by name or tag"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
                else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  const first = rows[0]?.node ?? starred[0];
                  if (first) { setSelectedKey(rows[0] ? treeKey(first.rel) : starKey(first.rel)); focusTreeSoon(); }
                }
              }}
            />
            {query && (
              <button type="button" className="vt-icon-btn" style={{ width: 18, height: 18 }} aria-label="Clear search"
                      onClick={() => { setQuery(""); searchRef.current?.focus(); }}>
                <X size={12} />
              </button>
            )}
          </label>

          <TagBar
            tags={tags}
            selected={selTags}
            onToggle={(t) => setSelTags((s) => s.some((x) => x.toLowerCase() === t.toLowerCase())
              ? s.filter((x) => x.toLowerCase() !== t.toLowerCase()) : [...s, t])}
            onClear={() => setSelTags([])}
          />

          <div ref={treeWrapRef} className="flex flex-col flex-1 min-h-0">
            <VaultTree
              rows={rows}
              starred={starred}
              starredOpen={starredOpen}
              onStarredOpen={setStarredOpen}
              isExpanded={isExpanded}
              selectedKey={selectedKey}
              openRels={openRels}
              editingKey={editingKey}
              renderEditor={renderEditor}
              creating={createRow ? { parent: creating!.parent, row: createRow } : null}
              empty={emptyState}
              onSelectKey={setSelectedKey}
              onActivate={activate}
              onToggle={toggle}
              onRename={(key) => { setSelectedKey(key); setCreating(null); setEditingKey(key); }}
              onTrash={askTrash}
              onMenu={openMenu}
              onMove={(rel, dest) => void doMove(rel, dest)}
            />
          </div>
        </>
      )}

      <div className="vt-footer">
        <button
          type="button"
          className={`vt-footer-row${showTrash ? " is-active" : ""}`}
          aria-pressed={showTrash}
          onClick={() => setShowTrash((v) => !v)}
          title="Deleted items are kept for 30 days"
        >
          <Trash2 size={13} aria-hidden /> Trash
          {trashCount > 0 && <span className="vt-count">{trashCount}</span>}
        </button>
        {footer}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenu(menu.node, sort, handlers)}
          onClose={() => setMenu(null)}
        />
      )}
      {tagEdit && (
        <TagEditor
          name={tagEdit.name}
          initial={tagEdit.tags}
          allTags={tags.map((t) => t.tag)}
          onSave={(t) => A.setTags(root, tagEdit.rel, t)}
          onClose={() => setTagEdit(null)}
        />
      )}
      {moving && (
        <MoveDialog
          rel={moving.rel}
          name={moving.name}
          folders={folders}
          onClose={() => setMoving(null)}
          onMove={(dest) => { const n = moving; setMoving(null); void doMove(n.rel, dest); }}
        />
      )}
      {confirmTrash && (
        <ConfirmDialog
          title="Move folder to Trash?"
          message={`“${confirmTrash.name}”${confirmCount ? ` and the ${confirmCount} item${confirmCount === 1 ? "" : "s"} inside it` : ""} will be moved to Trash. You can restore it for 30 days.`}
          confirmLabel="Move to Trash"
          danger
          onCancel={() => setConfirmTrash(null)}
          onConfirm={() => { const n = confirmTrash; setConfirmTrash(null); void A.trashEntry(root, n.rel, true); }}
        />
      )}
    </>
  );
}
