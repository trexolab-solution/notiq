import type { RemoteEntry } from "../../../lib/sftp";

/** "Delete folder “x”?", "Delete file “x”?" or "Delete 3 items?". */
export function deleteTitle(list: RemoteEntry[]): string {
  if (list.length > 1) return `Delete ${list.length} items?`;
  return `Delete ${list[0].kind === "dir" ? "folder" : "file"} “${list[0].name}”?`;
}

/** What deleting will do, in plain words: permanent (a server has no Recycle Bin), and folders take their contents along. */
export function deleteMessage(list: RemoteEntry[], server: string): string {
  const folders = list.filter((e) => e.kind === "dir").length;
  if (list.length === 1) {
    return folders
      ? `The folder and everything inside it will be permanently deleted from ${server}. This can't be undone.`
      : `The file will be permanently deleted from ${server}. This can't be undone.`;
  }
  return folders
    ? `These items will be permanently deleted from ${server}, including everything inside the folders. This can't be undone.`
    : `These files will be permanently deleted from ${server}. This can't be undone.`;
}
