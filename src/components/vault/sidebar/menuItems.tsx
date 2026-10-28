import {
  ArrowDownAZ, ChevronsDownUp, ChevronsUpDown, Clock, Copy, ExternalLink, FolderInput, FolderPlus, Pencil, Star,
  StarOff, Tags, Trash2,
} from "lucide-react";
import type { ContextMenuItem } from "../../ui/ContextMenu";
import { NEW_ENTRY_OPTIONS, type NewEntryKind } from "../../../lib/vaultCreate";
import type { SortMode, TreeNode } from "../../../lib/vaultTree";
import { EntryIcon } from "./EntryIcon";

export interface MenuHandlers {
  open: (n: TreeNode) => void;
  rename: (n: TreeNode) => void;
  tags: (n: TreeNode) => void;
  star: (n: TreeNode) => void;
  duplicate: (n: TreeNode) => void;
  move: (n: TreeNode) => void;
  trash: (n: TreeNode) => void;
  create: (kind: NewEntryKind | "folder", parent: string) => void;
  sort: (m: SortMode) => void;
  expandAll: () => void;
  collapseAll: () => void;
}

const icon = (el: JSX.Element) => <span className="inline-flex">{el}</span>;
const KIND = { note: "note", login: "login", ssh: "ssh", secret: "secret" } as const;

function newItems(parent: string, h: MenuHandlers): ContextMenuItem[] {
  return [
    ...NEW_ENTRY_OPTIONS.map((o): ContextMenuItem => ({
      type: "item", label: `New ${o.label.toLowerCase()}`, icon: <EntryIcon kind={KIND[o.kind]} size={14} />,
      onClick: () => h.create(o.kind, parent),
    })),
    { type: "item", label: "New folder", icon: icon(<FolderPlus size={14} />), onClick: () => h.create("folder", parent) },
  ];
}

/** Context-menu entries for a row (`node`) or the empty tree area (`node` null). */
export function buildMenu(node: TreeNode | null, sort: SortMode, h: MenuHandlers): ContextMenuItem[] {
  if (!node) {
    return [
      ...newItems("", h),
      { type: "separator" },
      { type: "label", label: "Sort by" },
      { type: "item", label: sort === "name" ? "Name  ✓" : "Name", icon: icon(<ArrowDownAZ size={14} />), onClick: () => h.sort("name") },
      { type: "item", label: sort === "modified" ? "Recently modified  ✓" : "Recently modified", icon: icon(<Clock size={14} />), onClick: () => h.sort("modified") },
      { type: "separator" },
      { type: "item", label: "Expand all folders", icon: icon(<ChevronsUpDown size={14} />), onClick: h.expandAll },
      { type: "item", label: "Collapse all folders", icon: icon(<ChevronsDownUp size={14} />), onClick: h.collapseAll },
    ];
  }
  const star: ContextMenuItem = node.starred
    ? { type: "item", label: "Unstar", icon: icon(<StarOff size={14} />), onClick: () => h.star(node) }
    : { type: "item", label: "Star", icon: icon(<Star size={14} />), onClick: () => h.star(node) };

  if (node.dir) {
    return [
      { type: "label", label: `New in ${node.name}` },
      ...newItems(node.rel, h),
      { type: "separator" },
      { type: "item", label: "Rename", shortcut: "F2", icon: icon(<Pencil size={14} />), onClick: () => h.rename(node) },
      star,
      { type: "item", label: "Move to…", icon: icon(<FolderInput size={14} />), onClick: () => h.move(node) },
      { type: "separator" },
      { type: "item", label: "Move to Trash", shortcut: "Del", danger: true, icon: icon(<Trash2 size={14} />), onClick: () => h.trash(node) },
    ];
  }
  return [
    { type: "item", label: "Open", shortcut: "Enter", icon: icon(<ExternalLink size={14} />), onClick: () => h.open(node) },
    { type: "item", label: "Rename", shortcut: "F2", icon: icon(<Pencil size={14} />), onClick: () => h.rename(node) },
    { type: "item", label: "Edit tags…", icon: icon(<Tags size={14} />), onClick: () => h.tags(node) },
    star,
    { type: "separator" },
    { type: "item", label: "Duplicate", icon: icon(<Copy size={14} />), onClick: () => h.duplicate(node) },
    { type: "item", label: "Move to…", icon: icon(<FolderInput size={14} />), onClick: () => h.move(node) },
    { type: "separator" },
    { type: "item", label: "Move to Trash", shortcut: "Del", danger: true, icon: icon(<Trash2 size={14} />), onClick: () => h.trash(node) },
  ];
}
