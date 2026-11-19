import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_FIELDS, MAX_CUSTOM_LABEL, parseCustomFields } from "./customFields";

describe("parseCustomFields", () => {
  it("returns [] for non-arrays", () => {
    for (const v of [undefined, null, "x", 5, {}]) expect(parseCustomFields(v)).toEqual([]);
  });
  it("skips non-objects and coerces bad member types", () => {
    const out = parseCustomFields([null, "s", 3, { label: 1, value: 2, secret: "true" }, { label: "A", value: "B", secret: true }]);
    expect(out).toEqual([
      { label: "", value: "", secret: false },
      { label: "A", value: "B", secret: true },
    ]);
  });
  it("clips long labels and caps the count", () => {
    const out = parseCustomFields(Array.from({ length: 50 }, () => ({ label: "x".repeat(200), value: "v" })));
    expect(out).toHaveLength(MAX_CUSTOM_FIELDS);
    expect(out[0].label).toHaveLength(MAX_CUSTOM_LABEL);
  });
});
