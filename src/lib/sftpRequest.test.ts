import { describe, it, expect, beforeEach } from "vitest";
import { onRemoteFilesRequest, requestRemoteFiles, takePendingRemoteFiles } from "./sftpRequest";

const t = { path: "C:/v/web.nqv", auth: "key" as const, title: "web" };

beforeEach(() => { takePendingRemoteFiles(); });

describe("remote file manager requests", () => {
  it("tells every listener", () => {
    const seen: string[] = [];
    const off = onRemoteFilesRequest((x) => seen.push(x.title));
    requestRemoteFiles(t);
    off();
    expect(seen).toEqual(["web"]);
  });
  it("keeps a request made before the host exists, once", () => {
    requestRemoteFiles(t);
    expect(takePendingRemoteFiles()).toEqual(t);
    expect(takePendingRemoteFiles()).toBeNull();
  });
  it("stops notifying after unsubscribe", () => {
    const seen: string[] = [];
    onRemoteFilesRequest((x) => seen.push(x.title))();
    requestRemoteFiles(t);
    expect(seen).toEqual([]);
  });
});
