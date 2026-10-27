import { describe, expect, it } from "vitest";
import { emptySecret, parseSecret, serializeSecret } from "./secretEntry";

describe("secret entries", () => {
  it("round-trips and keeps only known fields", () => {
    const e = emptySecret("ssh", "prod");
    e.fields.host = "1.2.3.4";
    const back = parseSecret("ssh", serializeSecret(e));
    expect(back.title).toBe("prod");
    expect(back.fields.host).toBe("1.2.3.4");
    expect(back.fields.privateKey).toBe("");
  });
  it("tolerates garbage", () => {
    expect(parseSecret("secret", "not json").fields).toEqual({});
  });
});
