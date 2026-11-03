import { useEffect, useState } from "react";
import { SettingRow } from "../SettingRow";
import { Toggle } from "../Toggle";
import { toast } from "../../../lib/toast";
import { isTauri } from "../../../lib/tauriWindow";
import { DEFAULT_AUTOFILL_INCOGNITO, autofillIncognitoGet, autofillIncognitoSet } from "../../../lib/autofillIncognito";

export const AUTOFILL_INCOGNITO_LABEL = "Allow autofill in private (incognito) windows";

/** "Allow autofill in private (incognito) windows" (row of the "Browser autofill" group). */
export function AutofillIncognitoRow() {
  const [allow, setAllow] = useState(DEFAULT_AUTOFILL_INCOGNITO);
  useEffect(() => {
    if (!isTauri) return;
    autofillIncognitoGet().then(setAllow).catch(() => { /* keep the default */ });
  }, []);
  const change = (v: boolean) => {
    const prev = allow;
    setAllow(v);
    autofillIncognitoSet(v).catch(() => { setAllow(prev); toast.error("Could not change this setting"); });
  };
  return (
    <SettingRow
      id="vault.autofill.incognito"
      label={AUTOFILL_INCOGNITO_LABEL}
      description="When off, the extension does nothing in private windows: no icons, fills, save offers or passkeys, and Notiq refuses its requests from there. The browser must also allow the extension in private windows (its Details page: Allow in Incognito / InPrivate, or Run in Private Windows in Firefox)."
      keywords={["incognito", "private", "inprivate", "private window", "private browsing", "extension", "autofill"]}
      modified={allow !== DEFAULT_AUTOFILL_INCOGNITO}
      onReset={() => change(DEFAULT_AUTOFILL_INCOGNITO)}
    >
      <Toggle aria-label={AUTOFILL_INCOGNITO_LABEL} value={allow} onChange={change} />
    </SettingRow>
  );
}
