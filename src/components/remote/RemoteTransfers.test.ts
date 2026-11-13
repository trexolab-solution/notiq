import { describe, expect, it } from "vitest";
import { summarize, type Transfer } from "./RemoteTransfers";

const t = (id: number, kind: Transfer["kind"], state: Transfer["state"]): Transfer => ({ id, kind, name: `f${id}`, done: 0, total: 10, state });

describe("transfers headline", () => {
  it("says what is running", () => {
    expect(summarize([t(1, "up", "running")])).toMatchObject({ text: "Uploading 1 item", busy: true });
    expect(summarize([t(1, "up", "running"), t(2, "up", "running"), t(3, "up", "done")]).text).toBe("Uploading 2 items");
    expect(summarize([t(1, "down", "running")]).text).toBe("Downloading 1 item");
    expect(summarize([t(1, "down", "running"), t(2, "up", "running")]).text).toBe("Transferring 2 items");
  });

  it("says how it ended", () => {
    expect(summarize([t(1, "up", "done"), t(2, "up", "done")])).toMatchObject({ text: "2 uploads complete", busy: false, failed: 0 });
    expect(summarize([t(1, "down", "done")]).text).toBe("1 download complete");
    expect(summarize([t(1, "up", "done"), t(2, "down", "done")]).text).toBe("2 transfers complete");
    expect(summarize([t(1, "up", "done"), t(2, "up", "error")])).toMatchObject({ text: "1 transfer failed", failed: 1 });
    expect(summarize([t(1, "up", "cancelled")]).text).toBe("Nothing was transferred");
  });
});
