import type { NewEntryKind } from "../../../../lib/vaultCreate";
import { InlineLoading } from "../../../ui/Loading";

/** What the tree shows when it has no rows: loading, a read error, no search matches, or an empty vault. */
export function ExplorerEmptyState({ loading, error, filtering, onReload, onClearSearch, onCreate }: {
  loading: boolean;
  error: string | null;
  filtering: boolean;
  onReload: () => void;
  onClearSearch: () => void;
  onCreate: (kind: NewEntryKind | "folder") => void;
}) {
  return loading ? (
    <div className="vt-empty"><InlineLoading label="Loading items…" className="items-center" /></div>
  ) : error ? (
    <div className="vt-empty" role="alert">
      <div className="vt-empty-title text-[var(--color-danger)]">Couldn't read the vault</div>
      <div className="mb-2 break-words">{error}</div>
      <button type="button" className="vt-link" onClick={onReload}>Try again</button>
    </div>
  ) : filtering ? (
    <div className="vt-empty">
      <div className="vt-empty-title">No matches</div>
      Only names, websites, usernames and tags are searched — everything else stays encrypted.
      <div className="mt-2">
        <button type="button" className="vt-link" onClick={onClearSearch}>Clear search and tags</button>
      </div>
    </div>
  ) : (
    <div className="vt-empty">
      <div className="vt-empty-title">Your vault is empty</div>
      Keep notes, logins, SSH servers and API keys here, encrypted with your master password.
      <div className="mt-2 flex flex-col items-center gap-1">
        <button type="button" className="vt-link" onClick={() => onCreate("note")}>New secure note</button>
        <button type="button" className="vt-link" onClick={() => onCreate("login")}>New login</button>
        <button type="button" className="vt-link" onClick={() => onCreate("folder")}>New folder</button>
      </div>
    </div>
  );
}
