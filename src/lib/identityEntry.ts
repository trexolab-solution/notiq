/** Pure helpers for the Identity vault entry (name, email, phone, address; no React; unit-tested). */

export const IDENTITY_EXT = "identity";

/** The values the browser extension receives for an approved identity fill (`fill_identity` reply). */
export interface IdentityFill {
  name: string;
  email: string;
  phone: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postal: string;
  country: string;
}

export const IDENTITY_FILL_KEYS = [
  "name", "email", "phone", "address1", "address2", "city", "state", "postal", "country",
] as const satisfies readonly (keyof IdentityFill)[];

/** Per-value caps of the reply (the extension refuses anything longer). */
export const IDENTITY_MAX: Record<keyof IdentityFill, number> = {
  name: 100, email: 200, phone: 40, address1: 200, address2: 200, city: 100, state: 100, postal: 20, country: 100,
};

/** One line of plain text: control characters and runs of spaces become one space, trimmed, capped. */
const oneLine = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The fill values of an identity's fields, or null when it has nothing to fill. */
export function identityFill(fields: Record<string, string | undefined>): IdentityFill | null {
  const out = {} as IdentityFill;
  let any = false;
  for (const k of IDENTITY_FILL_KEYS) {
    out[k] = oneLine(fields[k], IDENTITY_MAX[k]);
    if (out[k]) any = true;
  }
  return any ? out : null;
}

/** A short, non-sensitive line for pickers: "Rahul Sharma · Bengaluru" (name and city only). */
export function identitySummary(f: Pick<IdentityFill, "name" | "city" | "email">): string {
  const parts = [f.name, f.city].filter(Boolean);
  return parts.length ? parts.join(" · ") : f.email;
}
