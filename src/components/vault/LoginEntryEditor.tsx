import { useMemo, useState } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useAppStore } from "../../store";
import { CopyIconButton } from "./CopyIconButton";
import { useAutoHide } from "../../hooks/useAutoHide";
import { GeneratePasswordButton } from "./GeneratePasswordButton";
import { CustomFieldsEditor } from "./CustomFieldsEditor";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { PasskeysList } from "./PasskeysList";
import { TotpPanel } from "./TotpPanel";
import { LoginSitesEditor } from "./LoginSitesEditor";
import { EntryHeader, EntryLayout, FieldRow, RevealButton, SaveHint, Section, fieldLabel, formColumn, textArea } from "./EntryParts";
import { hostOf, parseLogin, serializeLogin, type LoginEntry } from "../../lib/loginEntry";
import type { Tab } from "../../types";

/** Structured editor for a `login` vault entry (replaces the text editor). */
export function LoginEntryEditor({ tab }: { tab: Tab }) {
  const entry = useMemo(() => parseLogin(tab.content), [tab.content]);
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);
  const set = (patch: Partial<LoginEntry>) =>
    useAppStore.getState().updateTabContent(tab.id, serializeLogin({ ...entry, ...patch }));

  const host = hostOf(entry.url);
  const row = "flex items-center gap-2";

  return (
    <EntryLayout tab={tab}>
      <div className={formColumn}>
        <EntryHeader icon={KeyRound} title="Login" tab={tab} />

        <div>
          <label className={fieldLabel} htmlFor="le-title">Name</label>
          <Input id="le-title" value={entry.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Google" />
        </div>

        <Section title="Website">
          <div>
            <label className={fieldLabel} htmlFor="le-url">Address</label>
            <div className={row}>
              <Input id="le-url" value={entry.url} onChange={(e) => set({ url: e.target.value })}
                     placeholder="https://accounts.google.com" spellCheck={false} />
              {host && (
                <Button size="sm" icon={<ExternalLink size={12} />}
                        onClick={() => { void openUrl(`https://${host}`); }}>Open</Button>
              )}
            </div>
            <LoginSitesEditor entry={entry} onChange={(urls) => set({ urls })} />
          </div>
        </Section>

        <Section title="Sign in">
          <FieldRow htmlFor="le-user" text="Username or email"
                    actions={<CopyIconButton value={entry.username} label="username" />}>
            <Input id="le-user" value={entry.username} onChange={(e) => set({ username: e.target.value })}
                   autoComplete="off" spellCheck={false} />
          </FieldRow>

          <FieldRow htmlFor="le-pass" text="Password"
                    actions={<>
                      <RevealButton shown={show} onToggle={() => setShow((v) => !v)} name="password" />
                      <CopyIconButton value={entry.password} label="password" />
                    </>}>
            <div className={row}>
              <Input id="le-pass" type={show ? "text" : "password"} value={entry.password}
                     onChange={(e) => set({ password: e.target.value })}
                     autoComplete="off" spellCheck={false} className="font-mono" />
              <GeneratePasswordButton current={entry.password} onGenerate={(password) => { set({ password }); setShow(true); }} />
            </div>
          </FieldRow>
        </Section>

        <TotpPanel secret={entry.totp} onChange={(totp) => set({ totp })} />

        <Section title="Notes">
          <textarea id="le-notes" aria-label="Notes" rows={4} value={entry.notes} onChange={(e) => set({ notes: e.target.value })}
                    placeholder="Security questions, recovery hints, anything else worth keeping" className={textArea} />
        </Section>

        <CustomFieldsEditor value={entry.custom ?? []} onChange={(custom) => set({ custom })} />
        <PasskeysList value={entry.passkeys ?? []} onChange={(passkeys) => set({ passkeys })} />
        <AttachmentsPanel tab={tab} />
        <SaveHint />
      </div>
    </EntryLayout>
  );
}
