// @vitest-environment happy-dom
/** A `.nqb` opened from outside goes to the dialog for what it is: restore for a backup, import for a share file. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const inspect = vi.fn();
vi.mock("../../lib/vaultBackup", async (orig) => ({
  ...(await orig<typeof import("../../lib/vaultBackup")>()),
  vaultBackupInspect: (p: string) => inspect(p),
}));
vi.mock("./RestoreBackupDialog", () => ({ RestoreBackupDialog: ({ initialPath }: { initialPath: string }) => <div>restore:{initialPath}</div> }));
vi.mock("./ImportSharedDialog", () => ({ ImportSharedDialog: ({ initialPath }: { initialPath: string }) => <div>share:{initialPath}</div> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RestoreRequestHost } = await import("./RestoreRequestHost");
const { requestRestore, takePendingRestore } = await import("../../lib/restoreRequest");

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  inspect.mockReset();
  takePendingRestore();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function openWith(path: string) {
  await act(async () => { root.render(<RestoreRequestHost />); });
  await act(async () => { requestRestore(path); });
}

describe("RestoreRequestHost", () => {
  it("opens the restore dialog for a backup file", async () => {
    inspect.mockResolvedValue({ ok: true, kind: "backup" });
    await openWith("C:/a.nqb");
    expect(host.textContent).toBe("restore:C:/a.nqb");
  });

  it("opens the import dialog for a share file", async () => {
    inspect.mockResolvedValue({ ok: true, kind: "share" });
    await openWith("C:/s.nqb");
    expect(host.textContent).toBe("share:C:/s.nqb");
  });

  it("falls back to the restore dialog, which shows the reason, when the file can't be read", async () => {
    inspect.mockRejectedValue(new Error("nope"));
    await openWith("C:/x.nqb");
    expect(host.textContent).toBe("restore:C:/x.nqb");
  });
});
