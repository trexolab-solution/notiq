import { useMemo } from "react";
import { ListChecks } from "lucide-react";
import { Input } from "../ui/Input";
import { useAppStore } from "../../store";
import { useFocusNameOnCreate } from "../../hooks/useFocusNameOnCreate";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { RecoveryCodeList } from "./RecoveryCodeList";
import { EntryHeader, EntryLayout, SaveHint, Section, SectionedForm, fieldLabel, textArea } from "./EntryParts";
import { parseCodes, remainingCount, serializeCodes, type CodesEntry } from "../../lib/recoveryCodes";
import { setEntryEditing, useEntryEditing } from "../../lib/entryUi";
import type { Tab } from "../../types";

/** Recovery / backup codes entry, for codes that don't belong to a login. */
export function RecoveryCodesEditor({ tab }: { tab: Tab }) {
  const entry = useMemo(() => parseCodes(tab.content), [tab.content]);
  useFocusNameOnCreate(tab.filePath, "rc-title", () => setEntryEditing(tab.id, true));
  const readOnly = !useEntryEditing(tab);
  const save = (next: CodesEntry) => useAppStore.getState().updateTabContent(tab.id, serializeCodes(next));
  const left = remainingCount(entry.codes);

  return (
    <EntryLayout tab={tab}>
      <SectionedForm
        header={<EntryHeader icon={ListChecks} title="Recovery codes" tab={tab} />}
        footer={<SaveHint />}
        panels={[
          { id: "codes", label: "Codes", badge: entry.codes.length ? `${left}/${entry.codes.length}` : undefined, content: (
            <div className="flex flex-col gap-6">
              <Section title="Account">
                <div>
                  <label className={fieldLabel} htmlFor="rc-title">Name</label>
                  <Input id="rc-title" readOnly={readOnly} value={entry.title} onChange={(e) => save({ ...entry, title: e.target.value })} />
                </div>
                <div>
                  <label className={fieldLabel} htmlFor="rc-service">Service</label>
                  <Input id="rc-service" readOnly={readOnly} value={entry.service} placeholder="e.g. GitHub, Google, Microsoft"
                         onChange={(e) => save({ ...entry, service: e.target.value })} />
                </div>
              </Section>
              <RecoveryCodeList tabId={tab.id} title="Codes" codes={entry.codes}
                                onChange={(codes) => save({ ...entry, codes })} />
            </div>
          ) },
          { id: "notes", label: "Notes", content: (
            <Section title="Notes">
              <textarea id="rc-notes" readOnly={readOnly} aria-label="Notes" rows={3} value={entry.notes} className={textArea}
                        onChange={(e) => save({ ...entry, notes: e.target.value })} />
            </Section>
          ) },
          { id: "files", label: "Attachments", content: <AttachmentsPanel tab={tab} /> },
        ]} />
    </EntryLayout>
  );
}
