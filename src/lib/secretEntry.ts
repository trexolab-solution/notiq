import { parseCustomFields, type CustomField } from "./customFields";

/** Generic structured vault entries (SSH, API keys, cards, Wi-Fi …) described by a small schema. */
export type FieldType = "text" | "secret" | "multiline-secret" | "multiline" | "select" | "checkbox";
/** Input clean-up applied while typing (see the editor). */
export type FieldFormat = "card" | "expiry" | "digits";
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  /** `select` only: the allowed values (the first one is the default). */
  options?: string[];
  format?: FieldFormat;
  /** Max characters kept (after formatting). */
  maxLength?: number;
  /** `text` fields only: the input's type (keyboard / spell-check hint; the value is stored as typed). */
  inputType?: "email" | "tel";
  /** Stored and edited only by a dedicated editor (e.g. JSON); generic views and editors skip it. */
  internal?: boolean;
  /** Section heading the generic editor puts the field under; consecutive fields with the same group share a section. */
  group?: string;
  /** Share a row with neighbouring fields (half: two across, third: three across). Default: full width. */
  width?: "half" | "third";
}
export interface KindDef { ext: string; label: string; hint: string; fields: FieldDef[] }

export const WIFI_SECURITY = ["WPA2", "WPA3", "WEP", "Open"] as const;

export const SECRET_KINDS: Record<string, KindDef> = {
  ssh: {
    ext: "ssh", label: "SSH / server", hint: "Host, user, private key",
    fields: [
      { key: "host", label: "Host or IP", type: "text", placeholder: "server.example.com" },
      { key: "port", label: "Port", type: "text", placeholder: "22" },
      { key: "username", label: "Username", type: "text" },
      { key: "password", label: "Password (if any)", type: "secret" },
      { key: "privateKey", label: "Private key", type: "multiline-secret", placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----" },
      { key: "passphrase", label: "Key passphrase", type: "secret" },
      { key: "publicKey", label: "Public key", type: "multiline", placeholder: "ssh-ed25519 AAAA… user@host" },
      // Extra key files kept with the entry: JSON [{id,name,size,value}] (lib/sshKeyImport). Typed as a
      // secret so anything that ignores `internal` still treats it as one.
      { key: "keyFiles", label: "Other key files", type: "multiline-secret", internal: true },
      // Used by the dedicated SSH editor (src/components/vault/SshEntryEditor.tsx):
      { key: "auth", label: "Sign-in method", type: "text" },
      { key: "jump", label: "Jump host", type: "text", placeholder: "user@bastion.example.com" },
      { key: "fingerprint", label: "Host key fingerprint", type: "text", placeholder: "SHA256:…" },
      { key: "notes", label: "Notes", type: "multiline" },
    ],
  },
  secret: {
    ext: "secret", label: "API key / secret", hint: "Token, key, env value",
    fields: [
      { key: "service", label: "Service", type: "text", placeholder: "e.g. OpenAI, AWS, Stripe", group: "Credential" },
      { key: "key", label: "Key / token", type: "multiline-secret", group: "Credential" },
      { key: "env", label: "Env variable name (optional)", type: "text", placeholder: "OPENAI_API_KEY", group: "Credential" },
      { key: "notes", label: "Notes", type: "multiline", group: "Notes" },
    ],
  },
  card: {
    ext: "card", label: "Payment card", hint: "Card number, expiry, CVV, PIN",
    fields: [
      { key: "cardholder", label: "Cardholder name", type: "text", placeholder: "As printed on the card", group: "Card" },
      { key: "number", label: "Card number", type: "secret", format: "card", placeholder: "1234 5678 9012 3456", group: "Card" },
      { key: "expiry", label: "Expiry (MM/YY)", type: "text", format: "expiry", placeholder: "MM/YY", maxLength: 5, group: "Card", width: "half" },
      { key: "cvv", label: "Security code (CVV)", type: "secret", format: "digits", maxLength: 4, group: "Card", width: "half" },
      { key: "pin", label: "PIN", type: "secret", format: "digits", maxLength: 12, group: "Card", width: "half" },
      { key: "zip", label: "Billing ZIP / postcode", type: "text", maxLength: 12, group: "Card", width: "half" },
      { key: "notes", label: "Notes", type: "multiline", group: "Notes" },
    ],
  },
  wifi: {
    ext: "wifi", label: "Wi-Fi network", hint: "Network name, password, security",
    fields: [
      { key: "ssid", label: "Network name (SSID)", type: "text", placeholder: "MyHomeWiFi", group: "Network" },
      { key: "security", label: "Security", type: "select", options: [...WIFI_SECURITY], group: "Network" },
      { key: "password", label: "Password", type: "secret", group: "Network" },
      { key: "hidden", label: "Hidden network (doesn't broadcast its name)", type: "checkbox", group: "Network" },
      { key: "notes", label: "Notes", type: "multiline", group: "Notes" },
    ],
  },
  // Contact / address details for forms (e.g. "Home", "Office"). Not tied to a site; filled with approval.
  identity: {
    ext: "identity", label: "Identity", hint: "Name, email, phone, address for forms",
    fields: [
      { key: "name", label: "Full name", type: "text", placeholder: "As you write it on forms", maxLength: 100, group: "Contact" },
      { key: "email", label: "Email", type: "text", inputType: "email", placeholder: "you@example.com", maxLength: 200, group: "Contact", width: "half" },
      { key: "phone", label: "Phone", type: "text", inputType: "tel", placeholder: "+91 98765 43210", maxLength: 40, group: "Contact", width: "half" },
      { key: "address1", label: "Address line 1", type: "text", placeholder: "Flat / house no., building, street", maxLength: 200, group: "Address" },
      { key: "address2", label: "Address line 2", type: "text", placeholder: "Area, locality (optional)", maxLength: 200, group: "Address" },
      { key: "city", label: "City", type: "text", maxLength: 100, group: "Address", width: "half" },
      { key: "state", label: "State / province", type: "text", maxLength: 100, group: "Address", width: "half" },
      { key: "postal", label: "PIN / ZIP code", type: "text", maxLength: 20, group: "Address", width: "half" },
      { key: "country", label: "Country", type: "text", placeholder: "e.g. India", maxLength: 100, group: "Address", width: "half" },
      { key: "notes", label: "Notes", type: "multiline", group: "Notes" },
    ],
  },
};

export interface SecretEntry {
  v: 1;
  kind: string;
  title: string;
  fields: Record<string, string>;
  /** User-defined extra fields; absent in entries saved before 0.7.0. */
  custom: CustomField[];
}

export const emptySecret = (kind: string, title = ""): SecretEntry => ({ v: 1, kind, title, fields: {}, custom: [] });
export const serializeSecret = (e: SecretEntry): string => JSON.stringify(e);

/** Checkbox fields store "true" or "". */
export const isChecked = (v: string | undefined) => v === "true";

export function parseSecret(kind: string, raw: string): SecretEntry {
  try {
    const o = JSON.parse(raw) as Partial<SecretEntry>;
    const fields: Record<string, string> = {};
    for (const f of SECRET_KINDS[kind]?.fields ?? []) {
      const v = o.fields?.[f.key];
      fields[f.key] = typeof v === "string" ? v : "";
    }
    return { v: 1, kind, title: typeof o.title === "string" ? o.title : "", fields, custom: parseCustomFields(o.custom) };
  } catch {
    return emptySecret(kind);
  }
}
