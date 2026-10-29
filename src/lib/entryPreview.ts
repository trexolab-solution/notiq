import { LOGIN_EXT, parseLogin } from "./loginEntry";
import { parseSecret, SECRET_KINDS } from "./secretEntry";
import { CODES_EXT, parseCodes } from "./recoveryCodes";
import type { CustomField } from "./customFields";

/** One labelled value of a stored entry, for read-only previews (e.g. version history). */
export interface PreviewRow { label: string; value: string; secret: boolean }

const customRows = (c: CustomField[] | undefined): PreviewRow[] =>
  (c ?? []).map((f) => ({ label: f.label || "Custom field", value: f.value, secret: f.secret }));

/** Turns stored entry content into labelled rows (empty values dropped). Unknown types show the raw text. */
export function previewRows(ext: string, content: string): PreviewRow[] {
  let rows: PreviewRow[];
  if (ext === LOGIN_EXT) {
    const e = parseLogin(content);
    rows = [
      { label: "Name", value: e.title, secret: false },
      { label: "Website", value: e.url, secret: false },
      { label: "Other sites", value: e.urls.join(", "), secret: false },
      { label: "Username", value: e.username, secret: false },
      { label: "Password", value: e.password, secret: true },
      { label: "2-step secret", value: e.totp, secret: true },
      { label: "Notes", value: e.notes, secret: false },
      ...customRows(e.custom),
    ];
  } else if (ext === CODES_EXT) {
    const e = parseCodes(content);
    rows = [
      { label: "Name", value: e.title, secret: false },
      { label: "Service", value: e.service, secret: false },
      { label: `Codes (${e.codes.filter((c) => !c.used).length} of ${e.codes.length} unused)`,
        value: e.codes.map((c) => (c.used ? `${c.code} (used)` : c.code)).join("\n"), secret: true },
      { label: "Notes", value: e.notes, secret: false },
    ];
  } else if (SECRET_KINDS[ext]) {
    const e = parseSecret(ext, content);
    rows = [
      { label: "Name", value: e.title, secret: false },
      ...SECRET_KINDS[ext].fields
        .filter((f) => !(ext === "ssh" && f.key === "auth"))
        .map((f) => ({
          label: f.label,
          value: f.type === "checkbox" ? (e.fields[f.key] === "true" ? "Yes" : "") : e.fields[f.key] ?? "",
          secret: f.type === "secret" || f.type === "multiline-secret",
        })),
      ...customRows(e.custom),
    ];
  } else {
    rows = [{ label: "Content", value: content, secret: true }];
  }
  return rows.filter((r) => r.value.trim() !== "");
}
