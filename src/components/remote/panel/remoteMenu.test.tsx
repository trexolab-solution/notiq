import { describe, expect, it, vi } from "vitest";
import { remoteMenuItems, type RemoteMenuActions } from "./remoteMenu";
import type { RemoteEntry } from "../../../lib/sftp";

const entry = (name: string, kind: RemoteEntry["kind"] = "file"): RemoteEntry => ({ name, kind, link: false, size: 1, mtime: 1, mode: 0o644 });

function actions(over: Partial<RemoteMenuActions> = {}): RemoteMenuActions {
  const f = vi.fn();
  return {
    path: "/home/a", selected: new Set(), picked: [], trashOn: true, chooseUpload: f, chooseUploadFolder: f, setPrompt: f, paste: f, load: f, copy: f,
    setShowTrash: f, openEntry: f, download: f, cut: f, askDelete: f, askDeleteForever: f, showProperties: f,
    tools: { zip: true, unzip: true, tar: true }, compress: f, extractHere: f, extractToFolder: f, ...over,
  };
}
const labels = (items: ReturnType<typeof remoteMenuItems>) => items.flatMap((i) => (i.type === "item" ? [i.label] : []));
/** No separator first, last or doubled. */
const tidy = (items: ReturnType<typeof remoteMenuItems>) =>
  items.length > 0 && items[0].type !== "separator" && items[items.length - 1].type !== "separator" && items.every((it, i) => !(it.type === "separator" && items[i - 1]?.type === "separator"));

describe("remote file manager context menu", () => {
  it("lists a label only once, for a file, a folder, a selection and empty space", () => {
    const cases = [
      remoteMenuItems(entry("a.txt"), actions()),
      remoteMenuItems(entry("src", "dir"), actions()),
      remoteMenuItems(entry("a.zip"), actions()),
      remoteMenuItems(entry("a"), actions({ selected: new Set(["a", "b"]), picked: [entry("a"), entry("b", "dir")] })),
      remoteMenuItems(null, actions()),
    ];
    for (const items of cases) {
      const l = labels(items);
      expect(new Set(l).size, l.join(" | ")).toBe(l.length);
      expect(tidy(items)).toBe(true);
    }
  });

  it("a row's menu has only item actions; empty space only folder actions", () => {
    const row = labels(remoteMenuItems(entry("a.txt"), actions()));
    for (const folderOnly of ["New folder…", "New file…", "Upload files…", "Upload folder…", "Refresh", "Copy folder path", "Open Trash"]) expect(row).not.toContain(folderOnly);
    const blank = labels(remoteMenuItems(null, actions()));
    for (const itemOnly of ["Open / edit", "Download…", "Cut", "Rename…", "Copy path", "Permissions…", "Move to Trash"]) expect(blank).not.toContain(itemOnly);
  });

  it("offers Extract only on an archive, Paste into folder only on a folder, and deletes last", () => {
    expect(labels(remoteMenuItems(entry("a.txt"), actions()))).not.toContain("Extract here");
    expect(labels(remoteMenuItems(entry("a.tar.gz"), actions()))).toContain("Extract here");
    expect(labels(remoteMenuItems(entry("a.txt"), actions()))).not.toContain("Paste into folder");
    expect(labels(remoteMenuItems(entry("d", "dir"), actions()))).toContain("Paste into folder");
    const l = labels(remoteMenuItems(entry("a.txt"), actions()));
    expect(l.slice(-2)).toEqual(["Move to Trash", "Delete permanently…"]);
  });
});
