import { describe, expect, it } from "vitest";
import { identityFill, identitySummary, IDENTITY_EXT } from "./identityEntry";
import { emptySecret, parseSecret, SECRET_KINDS, serializeSecret } from "./secretEntry";
import { identityReply, identityTitle, indexOfIdentity, type IdentityMatch } from "./autofill";
import { previewRows } from "./entryPreview";
import { entryKind } from "./vaultTree";

const home = {
  name: "Asha Rao", email: "asha@example.com", phone: "+91 98765 43210", address1: "Flat 4B, Lake View Apts",
  address2: "MG Road", city: "Bengaluru", state: "Karnataka", postal: "560001", country: "India",
};

describe("identity entry (model)", () => {
  it("is a structured kind stored as JSON like a card, with every form field", () => {
    expect(SECRET_KINDS.identity.ext).toBe(IDENTITY_EXT);
    expect(SECRET_KINDS.identity.fields.map((f) => f.key))
      .toEqual(["name", "email", "phone", "address1", "address2", "city", "state", "postal", "country", "notes"]);
    // Nothing in an identity is masked; email / phone get the right keyboard.
    expect(SECRET_KINDS.identity.fields.every((f) => f.type === "text" || f.type === "multiline")).toBe(true);
    expect(SECRET_KINDS.identity.fields.find((f) => f.key === "email")?.inputType).toBe("email");
    expect(SECRET_KINDS.identity.fields.find((f) => f.key === "phone")?.inputType).toBe("tel");
  });

  it("round-trips through serialize / parse and tolerates garbage", () => {
    const e = emptySecret("identity", "Home");
    e.fields = { ...home, notes: "gate code at the desk" };
    e.custom = [{ label: "GSTIN", value: "29ABCDE1234F1Z5", secret: false }];
    const raw = serializeSecret(e);
    expect(JSON.parse(raw)).toMatchObject({ v: 1, kind: "identity", title: "Home", fields: { city: "Bengaluru" } });
    const back = parseSecret("identity", raw);
    expect(back.fields).toEqual(e.fields);
    expect(back.custom).toEqual(e.custom);
    expect(parseSecret("identity", "not json").fields).toEqual({});
    expect(parseSecret("identity", JSON.stringify({ fields: { name: 5, city: "Pune" } })).fields).toMatchObject({ name: "", city: "Pune" });
  });

  it("is listed as its own kind in the vault tree", () => {
    expect(entryKind({ dir: false, ext: "identity" })).toBe("identity");
    expect(entryKind({ dir: true, ext: "identity" })).toBe("folder");
  });

  it("previews as labelled, unmasked rows (empty ones dropped)", () => {
    const e = emptySecret("identity", "Office");
    e.fields = { name: "Asha Rao", city: "Pune" };
    const rows = previewRows("identity", serializeSecret(e));
    expect(rows.map((r) => r.label)).toEqual(["Name", "Full name", "City"]);
    expect(rows.every((r) => !r.secret)).toBe(true);
  });
});

describe("identity fill values", () => {
  it("keeps the nine fill fields, one line each, capped", () => {
    expect(identityFill({ ...home, notes: "x" })).toEqual(home);
    const f = identityFill({ name: "  Asha\n\tRao  ", address1: "a".repeat(500), postal: "560 001" })!;
    expect(f.name).toBe("Asha Rao");
    expect(f.address1).toHaveLength(200);
    expect(f.postal).toBe("560 001");
    expect(f.email).toBe("");
  });

  it("is null for an identity with nothing to fill", () => {
    expect(identityFill({})).toBeNull();
    expect(identityFill({ name: "   ", notes: "only notes" })).toBeNull();
  });

  it("summary shows the name and city only", () => {
    expect(identitySummary(home)).toBe("Asha Rao · Bengaluru");
    expect(identitySummary({ name: "", city: "", email: "a@b.c" })).toBe("a@b.c");
  });
});

describe("identity autofill helpers", () => {
  const match = (rel: string, title = ""): IdentityMatch => {
    const entry = emptySecret("identity", title);
    entry.fields = { ...home };
    return { path: `/v/${rel}`, rel, entry, fill: identityFill(entry.fields)! };
  };

  it("title: entry title, else file name, else Identity", () => {
    expect(identityTitle(match("Ids/Home.nqv", " Home "))).toBe("Home");
    expect(identityTitle(match("Ids/Office.nqv"))).toBe("Office");
    expect(identityTitle({ entry: emptySecret("identity", ""), rel: ".nqv" })).toBe("Identity");
  });

  it("pre-selects the requested account (case-insensitive), else the first", () => {
    const list = [match("Ids/Home.nqv"), match("Ids/Office.nqv")];
    expect(indexOfIdentity(list, "ids/OFFICE.nqv")).toBe(1);
    expect(indexOfIdentity(list, "Ids/None.nqv")).toBe(0);
    expect(indexOfIdentity(list, "../etc")).toBe(0);
    expect(indexOfIdentity(list, undefined)).toBe(0);
  });

  it("reply carries ok, the title and exactly the fill fields (no notes or custom fields)", () => {
    const m = match("Ids/Home.nqv", "Home");
    m.entry.fields.notes = "private";
    m.entry.custom = [{ label: "PAN", value: "ABCDE1234F", secret: true }];
    expect(identityReply(m)).toEqual({ ok: true, title: "Home", ...home });
  });
});
