import { EntryIcon, kindLabel } from "./sidebar/EntryIcon";
import { displayName, entryKind } from "../../lib/vaultTree";
import { withFolders, type ShareItem } from "../../lib/vaultShare";

/**
 * What is in a share file, by name: each item under its folder, with the icon of its type, the type in words and how
 * many attachments it carries. Read-only (the import prompt shows it before anything is added).
 */
export function ShareItemList({ items }: { items: readonly ShareItem[] }) {
  const rows = withFolders(items);
  return (
    <ul className="max-h-[200px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-1" data-testid="share-items" aria-label="Items in this file">
      {rows.map((i) => {
        const kind = entryKind({ dir: i.dir, ext: i.ext });
        const depth = i.path.split("/").length - 1;
        return (
          <li key={i.path} style={{ paddingLeft: 12 + depth * 16 }} className="flex items-center gap-2 py-1 pr-3 text-[13px]" title={i.path}>
            <EntryIcon kind={kind} size={14} />
            <span className="min-w-0 flex-1 truncate">{displayName(i.path)}</span>
            {!i.dir && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{kindLabel(kind)}</span>}
            {i.attachments > 0 && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">· {i.attachments} {i.attachments === 1 ? "file" : "files"}</span>}
          </li>
        );
      })}
    </ul>
  );
}
