import { useEffect, useMemo, useState } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Input } from "../ui/Input";
import { useAppStore } from "../../store";
import { useFocusNameOnCreate } from "../../hooks/useFocusNameOnCreate";
import { ENTRY_FOCUS_EVENT, takeEntryFocus } from "../../lib/entryFocus";
import { CopyIconButton } from "./CopyIconButton";
import { RowIconButton } from "./ListEditor";
import { useAutoHide } from "../../hooks/useAutoHide";
import { GeneratePasswordButton } from "./GeneratePasswordButton";
import { CustomFieldsEditor } from "./CustomFieldsEditor";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { PasskeysList } from "./PasskeysList";
import { TotpPanel } from "./TotpPanel";
import { LoginSitesEditor } from "./LoginSitesEditor";
import { EntryHeader, EntryLayout, FieldRow, InputWithActions, RevealButton, SaveHint, Section, SectionedForm, fieldLabel, revealField, textArea } from "./EntryParts";
import { hostOf, parseLogin, serializeLogin, type LoginEntry } from "../../lib/loginEntry";
import type { Tab } from "../../types";

/** Structured editor for a `login` vault entry (replaces the text editor). */
export function LoginEntryEditor({ tab }: { tab: Tab }) {
  const entry = useMemo(() => parseLogin(tab.content), [tab.content]);
  useFocusNameOnCreate(tab.filePath, "le-title");
  // Vault health → "Fix": open the entry with the cursor already in the field that needs changing.
  useEffect(() => {
    const go = () => {
      const id = takeEntryFocus(tab.filePath);
      if (!id) return;
      // The field may be in a section that isn't shown: show it first, then focus once it is on screen.
      revealField(id);
      requestAnimationFrame(() => {
        const el = document.getElementById(id);
        el?.scrollIntoView({ block: "center" });
        el?.focus();
      });
    };
    go();
    window.addEventListener(ENTRY_FOCUS_EVENT, go);
    return () => window.removeEventListener(ENTRY_FOCUS_EVENT, go);
  }, [tab.filePath]);
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);
  const set = (patch: Partial<LoginEntry>) =>
    useAppStore.getState().updateTabContent(tab.id, serializeLogin({ ...entry, ...patch }));

  const host = hostOf(entry.url);

  return (
    <EntryLayout tab={tab}>
      <SectionedForm
        header={<EntryHeader icon={KeyRound} title="Login" tab={tab} />}
        footer={<SaveHint />}
        panels={[
          { id: "login", label: "Login", content: (<>
            <Section title="Website">
              <div>
                <label className={fieldLabel} htmlFor="le-title">Name</label>
                <Input id="le-title" value={entry.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Google" />
              </div>
              <div>
                <label className={fieldLabel} htmlFor="le-url">Address</label>
                <InputWithActions actions={host ? (
                  <RowIconButton label={`Open ${host}`} tooltip="Open this website" icon={<ExternalLink size={13} />}
                                 onClick={() => { void openUrl(`https://${host}`); }} />
                ) : undefined}>
                  <Input id="le-url" value={entry.url} onChange={(e) => set({ url: e.target.value })}
                         placeholder="https://accounts.google.com" spellCheck={false} />
                </InputWithActions>
                <LoginSitesEditor entry={entry} onChange={(urls) => set({ urls })} />
              </div>
            </Section>

            <Section title="Sign in">
              <FieldRow htmlFor="le-user" text="Username or email"
                        actions={<CopyIconButton value={entry.username} label="username" />}>
                <Input id="le-user" value={entry.username} onChange={(e) => set({ username: e.target.value })}
                       autoComplete="off" spellCheck={false} />
              </FieldRow>

              <FieldRow htmlFor="le-pass" text="Password">
                <InputWithActions actions={<>
                  <RevealButton shown={show} onToggle={() => setShow((v) => !v)} name="password" />
                  <CopyIconButton value={entry.password} label="password" />
                  <GeneratePasswordButton compact current={entry.password} onGenerate={(password) => { set({ password }); setShow(true); }} />
                </>}>
                  <Input id="le-pass" type={show ? "text" : "password"} value={entry.password}
                         onChange={(e) => set({ password: e.target.value })}
                         autoComplete="off" spellCheck={false} className="font-mono" />
                </InputWithActions>
              </FieldRow>
            </Section>
          </>) },
          { id: "security", label: "Security", content: (<>
            <TotpPanel secret={entry.totp} onChange={(totp) => set({ totp })} />
            <PasskeysList value={entry.passkeys ?? []} onChange={(passkeys) => set({ passkeys })} />
          </>) },
          { id: "details", label: "Details", badge: (entry.custom ?? []).length, content: (<>
            <Section title="Notes">
              <textarea id="le-notes" aria-label="Notes" rows={4} value={entry.notes} onChange={(e) => set({ notes: e.target.value })}
                        placeholder="Security questions, recovery hints, anything else worth keeping" className={textArea} />
            </Section>
            <CustomFieldsEditor value={entry.custom ?? []} onChange={(custom) => set({ custom })} />
          </>) },
          { id: "files", label: "Attachments", content: <AttachmentsPanel tab={tab} /> },
        ]} />
    </EntryLayout>
  );
}
