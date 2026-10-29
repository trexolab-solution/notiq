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
      { key: "service", label: "Service", type: "text", placeholder: "e.g. OpenAI, AWS, Stripe" },
      { key: "key", label: "Key / token", type: "multiline-secret" },
      { key: "env", label: "Env variable name (optional)", type: "text", placeholder: "OPENAI_API_KEY" },
      { key: "notes", label: "Notes", type: "multiline" },
    ],
  },
  card: {
    ext: "card", label: "Payment card", hint: "Card number, expiry, CVV, PIN",
    fields: [
      { key: "cardholder", label: "Cardholder name", type: "text", placeholder: "As printed on the card" },
      { key: "number", label: "Card number", type: "secret", format: "card", placeholder: "1234 5678 9012 3456" },
      { key: "expiry", label: "Expiry (MM/YY)", type: "text", format: "expiry", placeholder: "MM/YY", maxLength: 5 },
      { key: "cvv", label: "Security code (CVV)", type: "secret", format: "digits", maxLength: 4 },
      { key: "pin", label: "PIN", type: "secret", format: "digits", maxLength: 12 },
      { key: "zip", label: "Billing ZIP / postcode", type: "text", maxLength: 12 },
      { key: "notes", label: "Notes", type: "multiline" },
    ],
  },
  wifi: {
    ext: "wifi", label: "Wi-Fi network", hint: "Network name, password, security",
    fields: [
      { key: "ssid", label: "Network name (SSID)", type: "text", placeholder: "MyHomeWiFi" },
      { key: "password", label: "Password", type: "secret" },
      { key: "security", label: "Security", type: "select", options: [...WIFI_SECURITY] },
      { key: "hidden", label: "Hidden network (doesn't broadcast its name)", type: "checkbox" },
      { key: "notes", label: "Notes", type: "multiline" },
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
