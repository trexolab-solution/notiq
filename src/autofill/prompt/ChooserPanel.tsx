import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { DialogButton } from "../../components/ui/DialogParts";
import { showsSearch, visibleChoices, type ChoiceItem } from "../../components/vault/autofillChoices";
import { EntryDetailsView } from "../EntryDetailsView";
import { Panel, type Kind, type Refs } from "./Panel";

/** A chooser stage (logins, cards, identities): the list with Deny / Allow, or one row's read-only details view. */
export function ChooserPanel({
  refs, host, kind, trustNote, items, entries, busy, allowLabel, busyText, fillLabel, list,
  viewing, query, onDeny, onAllow, onCloseDetails, onPickAndAllow, onOpenInNotiq,
}: {
  refs: Refs; host: string; kind: Kind; trustNote: ReactNode; items: ChoiceItem[];
  entries: { path: string; rel?: string }[]; busy: boolean; allowLabel: string; busyText: string; fillLabel: string;
  list: ReactNode;
  /** The row whose details view is open, if any. */
  viewing: number | null;
  /** The chooser's search text. */
  query: string;
  onDeny: () => void;
  onAllow: () => void;
  onCloseDetails: () => void;
  onPickAndAllow: (index: number) => void;
  onOpenInNotiq: (rel: string) => void;
}) {
  const at = viewing;
  const viewed = at !== null ? entries[at] : undefined;
  // The search hides every row: there is nothing on screen to allow.
  const nothing = showsSearch(items.length) && visibleChoices(items, query).length === 0;
  return (
    <Panel refs={refs} host={host} icon="site" kind={kind} sub="Asked by the Notiq browser extension"
           onClose={onDeny} onEscape={viewed ? onCloseDetails : undefined} defaultFocus="cancel"
           footer={viewed ? null : <>
             <DialogButton cancel onClick={onDeny} disabled={busy}>Deny</DialogButton>
             <DialogButton variant="primary" className="af-allow" disabled={nothing} loading={busy}
                           loadingText={busyText} onClick={onAllow}>
               <span className="af-allow-label">{allowLabel}</span>
             </DialogButton>
           </>}>
      {viewed && at !== null ? (
        <EntryDetailsView key={viewed.path} path={viewed.path} title={items[at]?.title} onBack={onCloseDetails} busy={busy}
                          fillLabel={fillLabel} onFill={() => onPickAndAllow(at)}
                          onOpen={viewed.rel ? () => void onOpenInNotiq(viewed.rel!) : undefined} />
      ) : <>
        <div className="dlg-callout af-trust-note">
          <ShieldCheck size={14} className="shrink-0 mt-0.5" aria-hidden />
          <span>{trustNote}</span>
        </div>
        {list}
      </>}
    </Panel>
  );
}
