import { createContext, useContext } from "react";

/** What the parts of an entry form need to know about the entry they are in (provided by `EntryLayout`). */
export const EntryContext = createContext<{ tabId: string; path?: string; readOnly: boolean } | null>(null);

export const useEntryContext = () => useContext(EntryContext);

/** True while the entry is only being viewed. Parts used outside an entry form stay editable. */
export const useEntryReadOnly = (): boolean => !!useContext(EntryContext)?.readOnly;
