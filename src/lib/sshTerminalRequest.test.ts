import { describe, it, expect, beforeEach } from "vitest";
import { onSshRequest, requestSshSession, takePendingSsh } from "./sshTerminalRequest";

const t = { path: "C:/v/web.nqv", auth: "key" as const, title: "web" };

beforeEach(() => { takePendingSsh(); });

describe("ssh terminal requests", () => {
  it("tells every listener", () => {
    const a: string[] = [], b: string[] = [];
    const offA = onSshRequest((x) => a.push(x.title));
    const offB = onSshRequest((x) => b.push(x.title));
    requestSshSession(t);
    offA(); offB();
    expect([a, b]).toEqual([["web"], ["web"]]);
  });
  it("keeps a request made before the terminal exists, once", () => {
    requestSshSession(t);
    expect(takePendingSsh()).toEqual(t);
    expect(takePendingSsh()).toBeNull();
  });
  it("stops notifying after unsubscribe", () => {
    const seen: string[] = [];
    onSshRequest((x) => seen.push(x.title))();
    requestSshSession(t);
    expect(seen).toEqual([]);
  });
});
