import { Plus } from "lucide-react";
import { ChoiceList, type ChoiceItem } from "../components/vault/autofillChoices";
import type { LoginMatch } from "../lib/autofill";
import { passkeyLabel } from "../lib/passkeyEntry";
import type { PasskeyMatch } from "../lib/passkeys";

/** Which login a new passkey is saved on (`pick` -1 = a new login). Uses the same rows as the other choices. */
export function PasskeyTargetChoice({ logins, pick, onPick, disabled }: {
  logins: LoginMatch[]; pick: number; onPick: (index: number) => void; disabled?: boolean;
}) {
  const items: ChoiceItem[] = [
    ...logins.map((m, i) => {
      const title = m.entry.title || m.entry.url;
      return { value: i, key: m.path, title, avatar: title, sub: m.entry.username || "(no username)" };
    }),
    { value: -1, key: "new", title: "New login", avatar: "", icon: <Plus size={15} />, sub: "Saved in the Logins folder" },
  ];
  return <ChoiceList label="Save the passkey on" noun="logins" items={items} pick={pick} onPick={onPick} disabled={disabled} />;
}

/** Which saved passkey signs in: its user name and the login that holds it (never the key). */
export function PasskeyChoice({ passkeys, pick, onPick, disabled, onAllow }: {
  passkeys: PasskeyMatch[]; pick: number; onPick: (index: number) => void; disabled?: boolean; onAllow?: (index: number) => void;
}) {
  const items: ChoiceItem[] = passkeys.map((m, i) => {
    const title = passkeyLabel(m.passkey);
    return { value: i, key: `${m.path} ${m.passkey.credentialId}`, title, avatar: title, sub: m.title };
  });
  return <ChoiceList label="Saved passkeys" noun="passkeys" items={items} pick={pick} onPick={onPick} onAllow={onAllow} disabled={disabled} />;
}
