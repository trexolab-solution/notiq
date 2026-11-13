import { useEffect, useState } from "react";
import { RemoteFilesDialog } from "./RemoteFilesDialog";
import { onRemoteFilesRequest, takePendingRemoteFiles } from "../../lib/sftpRequest";
import type { SshTarget } from "../../lib/sshConnect";

/** Opens the remote file manager for a saved server when something asks for it. Mounted once in the app shell. */
export function RemoteFilesHost() {
  const [target, setTarget] = useState<(SshTarget & { n: number }) | null>(null);

  useEffect(() => {
    let n = 0;
    const early = takePendingRemoteFiles();
    if (early) setTarget({ ...early, n: ++n });
    return onRemoteFilesRequest((t) => { takePendingRemoteFiles(); setTarget({ ...t, n: ++n }); });
  }, []);

  if (!target) return null;
  // `key` starts a fresh session when another server is opened while this one is showing.
  return <RemoteFilesDialog key={target.n} target={target} onClose={() => setTarget(null)} />;
}
