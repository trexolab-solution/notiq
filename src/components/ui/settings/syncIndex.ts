import type { SettingMeta } from "../../../lib/settingsIndex";

/**
 * Search index of Settings → Vault → Sync (rendered by SyncSection.tsx). Pure data so the search can be
 * tested without the store; VaultSection appends it to its SETTINGS_INDEX.
 */
const SYNC_KEYWORDS = ["sync", "google drive", "cloud", "devices", "other pc"];

export const SYNC_INDEX: SettingMeta[] = [
  { id: "vault.sync.account", section: "vault", group: "Sync", label: "Google Drive account",
    description: "Connect the Google account your vault syncs through, or disconnect it.",
    keywords: [...SYNC_KEYWORDS, "connect", "disconnect", "reconnect", "sign in", "google account", "gmail"] },
  { id: "vault.sync.enabled", section: "vault", group: "Sync", label: "Sync on this PC",
    description: "Whether sync is on or paused on this PC: Pause to stop syncing while staying connected, Resume sync to sync again.",
    keywords: [...SYNC_KEYWORDS, "pause sync", "resume sync", "turn on sync", "enable sync", "disable sync", "live sync", "sync this vault"] },
  { id: "vault.sync.status", section: "vault", group: "Sync", label: "Sync status",
    description: "When the vault last synced, any problem, and a button to sync now.",
    keywords: [...SYNC_KEYWORDS, "sync now", "last synced", "error", "offline"] },
  { id: "vault.sync.device-name", section: "vault", group: "Sync", label: "This device's name",
    description: "How this PC appears in the devices list and in conflict notices.",
    keywords: [...SYNC_KEYWORDS, "device name", "computer name", "rename"] },
  { id: "vault.sync.devices", section: "vault", group: "Sync", label: "Devices",
    description: "Every device that syncs this vault, when it was last seen, and removing an old one.",
    keywords: [...SYNC_KEYWORDS, "remove device", "last seen", "computers"] },
  { id: "vault.sync.limits", section: "vault", group: "Sync", label: "Attachment limits",
    description: "Attachments sync too: up to 5 MB per file, 25 MB per vault and 20 files per note.",
    keywords: [...SYNC_KEYWORDS, "attachments", "files", "size", "limit"] },
  { id: "vault.sync.permissions", section: "vault", group: "Sync", label: "Google account permissions",
    description: "See or remove Notiq's access to your Google account on Google's permissions page.",
    keywords: [...SYNC_KEYWORDS, "revoke", "access", "third-party apps", "privacy"] },
];
