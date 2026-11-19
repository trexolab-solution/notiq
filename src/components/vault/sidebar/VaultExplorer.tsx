import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { VaultItem } from "../../../lib/vault";
import { DEFAULT_ENTRY_NAME, type NewEntryKind } from "../../../lib/vaultCreate";
import {
  ancestorsOf, childNames, displayName, entryKind, isSameOrUnder, nameError, nameTaken, parentRel, uniqueName,
  type TreeNode,
} from "../../../lib/vaultTree";
import { isGroupRow } from "../../../lib/vaultSites";
import { ContextMenu } from "../../ui/ContextMenu";
import type { VaultOpenMode } from "../../../lib/vaultTabs";
import { anyExpanded, relOfKey, targetFolderOf } from "./target";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import * as A from "./actions";
import { useExpanded, useGroupBySite, useSortMode, useStarredOpen } from "./prefs";
import { useVaultUsage } from "../../../lib/vaultUsage";
import { PanelHeader } from "./PanelHeader";
import { TagBar } from "./TagBar";
import { CreateRow, VaultTree, groupKey, starKey, treeKey } from "./VaultTree";
import { InlineNameInput } from "./InlineNameInput";
import { TagEditor } from "./TagEditor";
import { TagManagerDialog } from "./TagManagerDialog";
import { useOpenSshInTerminal } from "./useOpenSshInTerminal";
import { copyLoginField } from "./copyLogin";
import { BulkBar } from "./BulkBar";
import { openRemoteFiles } from "../../../lib/remoteFiles";
import { getFilesPlace, otherFilesPlace } from "../../../lib/vaultPrefs";
import { MoveDialog } from "./MoveDialog";
import { TrashView } from "./TrashView";
import { buildMenu, type MenuHandlers } from "./menuItems";
import { RecentlySyncedView } from "./RecentlySyncedView";
import { useExplorerTree } from "./explorer/useExplorerTree";
import { useSyncReview } from "./explorer/useSyncReview";
import { ExplorerHeaderActions } from "./explorer/ExplorerHeaderActions";
import { explorerMoreItems } from "./explorer/moreItems";
import { ExplorerEmptyState } from "./explorer/ExplorerEmptyState";
import { ExplorerSearch } from "./explorer/ExplorerSearch";
import { ExplorerFooter } from "./explorer/ExplorerFooter";
import { BulkDialogs } from "./explorer/BulkDialogs";

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

/** The unlocked vault: toolbar, search, tag filter, tree, trash, and every entry action. */
export function VaultExplorer({ root, items, trash, loading, error, reload, footer }: Props) {
  const { expanded, toggle, expandAll, collapseAll, remap } = useExpanded();
  const [sort, setSort] = useSortMode();
  const usage = useVaultUsage();
  const [starredOpen, setStarredOpen] = useStarredOpen();
  const [groupBySite, setGroupBySite] = useGroupBySite();

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
  // Rows ticked for a bulk action (rels), and the bulk dialogs.
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [bulkMoving, setBulkMoving] = useState(false);
  const [bulkTagging, setBulkTagging] = useState(false);
  const [confirmBulkTrash, setConfirmBulkTrash] = useState(false);
  const [managingTags, setManagingTags] = useState(false);
  const treeWrapRef = useRef<HTMLDivElement>(null);

  const {
    openRels, filtering, isExpanded, rows, subtitles, starred, tags, folders, trashCount,
  } = useExplorerTree({ root, items, trash, query, selTags, sort, usage, groupBySite, expanded });

  const { syncMarkers, reviewOpen, setReviewOpen, marks, syncedCount, markAllSeen } = useSyncReview(items);
  const showReview = reviewOpen && !showTrash;

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

  // Forget ticked rows that no longer exist (trashed, renamed or moved elsewhere, vault locked).
  useEffect(() => {
    setChecked((c) => {
      if (!c.size) return c;
      const next = new Set([...c].filter((r) => byRel.has(r.toLowerCase())));
      return next.size === c.size ? c : next;
    });
  }, [byRel]);
  const pickedItems = useMemo(
    () => [...checked].map((r) => byRel.get(r.toLowerCase())).filter((i): i is VaultItem => !!i),
    [checked, byRel],
  );

  /** Folder new things go into: none selected → root; a folder → it; an entry → its folder. */
  const targetFolder = targetFolderOf(selectedKey, (rel) => {
    const it = byRel.get(rel.toLowerCase());
    return it ? it.dir : folders.includes(rel);
  });
  const foldersOpen = useMemo(() => anyExpanded(expanded, folders), [expanded, folders]);

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
    const suggested = uniqueName(base, childNames(items, parent));
    if (kind !== "folder" && kind !== "note") {
      // A credential has its Name in its form: create it with a free default name and open the form (Name focused).
      setCreating(null);
      void A.createEntry(root, items, kind, parent, suggested).then((rel) => { if (rel) setSelectedKey(treeKey(rel)); });
      return;
    }
    setCreating({ parent, kind, suggested });
  }, [expandAll, items, root]);

  const validateIn = (folder: string, except?: string) => (name: string) =>
    nameError(name) ?? (nameTaken(items, folder, name, except) ? "That name is already used here" : null);

  // ── actions ────────────────────────────────────────────────────────────────
  const activate = useCallback((node: TreeNode, key: string, mode: VaultOpenMode = "preview") => {
    if (node.dir) {
      if (key.startsWith("s:")) { reveal(node.rel); toggle(node.rel, true); focusTreeSoon(); }
      else toggle(node.rel);
      return;
    }
    // Single click → the reusable preview tab; Ctrl/Cmd/middle-click, double-click → a tab of its own.
    void A.openEntry(root, node.rel, mode);
  }, [reveal, root, toggle]);

  const openMenu = useCallback((key: string | null, node: TreeNode | null, x: number, y: number) => {
    if (key) setSelectedKey(key);
    setMenu({ x, y, node });
  }, []);

  // A folder asks first (it takes everything inside it along). A single entry goes straight to the Trash:
  // the notice has an Undo, and the Recycle Bin keeps it for 30 days.
  const askTrash = useCallback((node: TreeNode) => {
    if (node.dir) setConfirmTrash(node);
    else void A.trashEntry(root, node.rel, false);
  }, [root]);

  const bulkMove = useCallback(async (dest: string) => {
    const rels = pickedItems.map((i) => i.rel);
    const moved = await A.moveMany(root, items, rels, dest);
    moved.forEach(([from, to]) => remap(from, to));
    if (dest) expandAll([...ancestorsOf(dest), dest]);
    setChecked(new Set());
  }, [expandAll, items, pickedItems, remap, root]);

  const doMove = useCallback(async (rel: string, dest: string) => {
    const to = await A.moveEntry(root, items, rel, dest);
    if (!to) return;
    remap(rel, to);
    if (dest) expandAll([...ancestorsOf(dest), dest]);
    setSelectedKey(treeKey(to));
  }, [expandAll, items, remap, root]);

  const sshTerminal = useOpenSshInTerminal(root);
  const sshFiles = useOpenSshInTerminal(root, (t) => openRemoteFiles(t));
  const sshFilesElsewhere = useOpenSshInTerminal(root, (t) => openRemoteFiles(t, otherFilesPlace(getFilesPlace())));

  const handlers: MenuHandlers = {
    open: (n) => void A.openEntry(root, n.rel, "preview"),
    openNewTab: (n) => void A.openEntry(root, n.rel, "permanent"),
    openTerminal: (n) => void sshTerminal.open(n.rel),
    openFiles: (n) => void sshFiles.open(n.rel),
    openFilesElsewhere: (n) => void sshFilesElsewhere.open(n.rel),
    copyLogin: (n, field) => void copyLoginField(root, n.rel, field),
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
    collapseAll,
    groupBySite,
    setGroupBySite,
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

  const emptyState = (
    <ExplorerEmptyState loading={loading} error={error} filtering={filtering} onReload={() => void reload()}
                        onClearSearch={() => { setQuery(""); setSelTags([]); }} onCreate={(k) => startCreate(k, "")} />
  );

  const targetLabel = targetFolder ? displayName(targetFolder) : "the vault root";
  const confirmCount = confirmTrash
    ? items.filter((i) => i.rel !== confirmTrash.rel && isSameOrUnder(i.rel, confirmTrash.rel)).length
    : 0;

  // Rare actions and view options live in the header's "More actions" menu.
  const moreItems = explorerMoreItems({
    sort, setSort, groupBySite, setGroupBySite, syncedCount, onManageTags: () => setManagingTags(true),
    onRecentlySynced: () => { setShowTrash(false); setReviewOpen(true); }, onMarkAllSeen: markAllSeen,
  });
  const collapseDisabled = filtering || folders.length === 0;

  return (
    <>
      <PanelHeader
        unlocked
        moreItems={moreItems}
        actions={
          <ExplorerHeaderActions
            targetLabel={targetLabel}
            onCreate={(k) => startCreate(k, targetFolder)}
            onNewFolder={() => startCreate("folder", targetFolder)}
            foldersOpen={foldersOpen}
            collapseDisabled={collapseDisabled}
            filtering={filtering}
            onCollapseAll={collapseAll}
            onExpandAll={() => expandAll(folders)}
          />
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
      ) : showReview ? (
        <RecentlySyncedView
          markers={syncMarkers}
          items={items}
          onBack={() => setReviewOpen(false)}
          onOpen={(m) => { reveal(m.rel); void A.openEntry(root, m.rel, "preview"); }}
          onMarkAllSeen={markAllSeen}
        />
      ) : (
        <>
          <ExplorerSearch
            query={query}
            onQuery={setQuery}
            onArrowDown={() => {
              const r0 = rows[0];
              if (r0) setSelectedKey(isGroupRow(r0) ? groupKey(r0.group.rel) : treeKey(r0.node.rel));
              else if (starred[0]) setSelectedKey(starKey(starred[0].rel));
              if (r0 || starred[0]) focusTreeSoon();
            }}
          />

          <TagBar
            tags={tags}
            selected={selTags}
            onToggle={(t) => setSelTags((s) => s.some((x) => x.toLowerCase() === t.toLowerCase())
              ? s.filter((x) => x.toLowerCase() !== t.toLowerCase()) : [...s, t])}
            onClear={() => setSelTags([])}
            onManage={() => setManagingTags(true)}
          />

          {checked.size > 0 && (
            <BulkBar
              count={pickedItems.filter((i) => !i.dir).length || pickedItems.length}
              onStar={(v) => void A.starMany(root, [...checked], v)}
              onTags={() => setBulkTagging(true)}
              onMove={() => setBulkMoving(true)}
              onTrash={() => setConfirmBulkTrash(true)}
              onClear={() => setChecked(new Set())}
            />
          )}

          <div ref={treeWrapRef} className="flex flex-col flex-1 min-h-0">
            <VaultTree
              rows={rows}
              subtitles={subtitles}
              starred={starred}
              starredOpen={starredOpen}
              onStarredOpen={setStarredOpen}
              isExpanded={isExpanded}
              selectedKey={selectedKey}
              targetFolder={targetFolder}
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
              onOpenTerminal={(n) => void sshTerminal.open(n.rel)}
              onOpenFiles={(n) => void sshFiles.open(n.rel)}
              onCopyLogin={(n, field) => void copyLoginField(root, n.rel, field)}
              checked={checked}
              onCheckedChange={setChecked}
              onTrashChecked={() => setConfirmBulkTrash(true)}
              onMenu={openMenu}
              onMove={(rel, dest) => void doMove(rel, dest)}
              marks={marks}
            />
          </div>
        </>
      )}

      <ExplorerFooter
        syncedCount={syncedCount}
        showReview={showReview}
        onToggleReview={() => { setShowTrash(false); setReviewOpen(!showReview); }}
        showTrash={showTrash}
        onToggleTrash={() => { setReviewOpen(false); setShowTrash((v) => !v); }}
        trashCount={trashCount}
      >
        {footer}
      </ExplorerFooter>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenu(menu.node, sort, handlers)}
          onClose={() => setMenu(null)}
        />
      )}
      {sshTerminal.dialog}
      {sshFiles.dialog}
      {sshFilesElsewhere.dialog}
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
      {managingTags && (
        <TagManagerDialog
          tags={tags}
          onRename={async (from, to) => {
            const ok = await A.renameTagEverywhere(root, items, from, to);
            if (ok) setSelTags((s) => s.map((t) => (t.toLowerCase() === from.toLowerCase() ? to : t)));
            return ok;
          }}
          onDelete={(tag) => A.deleteTagEverywhere(root, items, tag)}
          onClose={() => setManagingTags(false)}
        />
      )}
      <BulkDialogs
        root={root}
        pickedItems={pickedItems}
        allTags={tags.map((t) => t.tag)}
        folders={folders}
        tagging={bulkTagging}
        moving={bulkMoving}
        confirmingTrash={confirmBulkTrash}
        onCloseTagging={() => setBulkTagging(false)}
        onCloseMoving={() => setBulkMoving(false)}
        onCloseTrash={() => setConfirmBulkTrash(false)}
        onMove={(dest) => void bulkMove(dest)}
        onDone={() => setChecked(new Set())}
      />
      {confirmTrash && (
        <ConfirmDialog
          title={confirmTrash.dir ? "Move folder to Trash?" : "Move to Trash?"}
          message={`“${confirmTrash.name}”${confirmCount ? ` and the ${confirmCount} item${confirmCount === 1 ? "" : "s"} inside it` : ""} will be moved to Trash. You can restore it for 30 days.`}
          confirmLabel="Move to Trash"
          danger
          onCancel={() => setConfirmTrash(null)}
          onConfirm={() => { const n = confirmTrash; setConfirmTrash(null); void A.trashEntry(root, n.rel, n.dir); }}
        />
      )}
    </>
  );
}
