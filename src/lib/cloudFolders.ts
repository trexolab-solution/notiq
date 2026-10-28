/** Folders that a cloud-sync client mirrors to the internet: not a good home for a vault database. */
const CLOUD: { name: string; test: RegExp }[] = [
  { name: "OneDrive",     test: /(^|\/)onedrive([ \-_][^/]*)?(\/|$)/i },
  { name: "Dropbox",      test: /(^|\/)dropbox([ \-_][^/]*)?(\/|$)/i },
  { name: "Google Drive", test: /(^|\/)(google ?drive|my drive)([ \-_][^/]*)?(\/|$)/i },
  { name: "iCloud Drive", test: /(^|\/)(icloud ?drive|iclouddrive|mobile documents|com~apple~clouddocs)(\/|$)/i },
  { name: "Box",          test: /(^|\/)box( sync)?(\/|$)/i },
  { name: "pCloud",       test: /(^|\/)pcloud( ?drive)?(\/|$)/i },
  { name: "MEGA",         test: /(^|\/)mega(sync)?(\/|$)/i },
];

/** The name of the cloud-sync service that probably mirrors `path`, or null. */
export function cloudFolderName(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  return CLOUD.find((c) => c.test.test(p))?.name ?? null;
}
