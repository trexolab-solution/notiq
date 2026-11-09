import { describe, expect, it } from "vitest";
import { diffEntries } from "./entryDiff";

const login = (o: Record<string, unknown>) => ({ ext: "login", content: JSON.stringify({ title: "Bank", username: "me", password: "old", ...o }) });

describe("diffEntries", () => {
  it("marks changed, added and removed fields; secrets stay flagged", () => {
    const d = diffEntries(login({ notes: "gone soon" }), login({ password: "new", url: "https://bank.example" }));
    const by = Object.fromEntries(d.map((x) => [x.label, x]));
    expect(by.Password).toMatchObject({ status: "changed", before: "old", after: "new", secret: true });
    expect(by.Website).toMatchObject({ status: "added", before: null });
    expect(by.Notes).toMatchObject({ status: "removed", after: null });
    expect(by.Username.status).toBe("same");
    expect(d[d.length - 1].label).toBe("Notes"); // fields only the old version had come last
  });

  it("compares plain notes as one masked content field", () => {
    const d = diffEntries({ ext: "md", content: "a" }, { ext: "md", content: "b" });
    expect(d).toEqual([{ label: "Content", before: "a", after: "b", secret: true, status: "changed" }]);
  });
});
