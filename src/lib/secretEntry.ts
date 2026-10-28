/** Generic structured vault entries (SSH, API keys …) described by a small schema. */
export type FieldType = "text" | "secret" | "multiline-secret" | "multiline";
export interface FieldDef { key: string; label: string; type: FieldType; placeholder?: string }
export interface KindDef { ext: string; label: string; hint: string; fields: FieldDef[] }

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
};

export interface SecretEntry { v: 1; kind: string; title: string; fields: Record<string, string> }

export const emptySecret = (kind: string, title = ""): SecretEntry => ({ v: 1, kind, title, fields: {} });
export const serializeSecret = (e: SecretEntry): string => JSON.stringify(e);

export function parseSecret(kind: string, raw: string): SecretEntry {
  try {
    const o = JSON.parse(raw) as Partial<SecretEntry>;
    const fields: Record<string, string> = {};
    for (const f of SECRET_KINDS[kind]?.fields ?? []) {
      const v = o.fields?.[f.key];
      fields[f.key] = typeof v === "string" ? v : "";
    }
    return { v: 1, kind, title: typeof o.title === "string" ? o.title : "", fields };
  } catch {
    return emptySecret(kind);
  }
}
