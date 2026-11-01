# Vault Sync — design and implementation plan (v0.9.0)

Status: agreed with the maintainer on 2026-10-31. Implementation not started.

## Goal

The Secure Vault stays local-first, and can optionally sync through the user's own cloud storage so that:

1. A vault set up on machine 1 opens on machine 2 with **only the Google sign-in (once) and the master password**.
2. Using the vault on two machines at the same time **never loses data**: every change from every device ends up
   everywhere; where the same entry was edited on both, the newer edit wins and the other version is kept in the
   entry's history.

## Decisions

| # | Decision |
|---|---|
| Scope | **Vault only.** Plain notes are not synced. |
| First provider | **Google Drive API** (in-app Google sign-in), scope `drive.appdata` only. |
| Architecture | One sync/backup **engine**, written once, on top of a small **`StorageProvider`** trait. OneDrive, WebDAV/S3/custom server, a local/network folder and Telegram (backup-only) can be added later without touching the engine. |
| Conflicts | Last writer wins **per entry** (hybrid logical clock); the losing version goes into the entry's history, marked as a conflict from device X; the user gets one notification. A delete racing an edit: **the edit wins.** |
| Attachments | Synced, within today's limits (`vault_db.rs`: 5 MB per file, 25 MB per vault, 20 per entry). The UI states these limits in the attachments panel and in Settings → Sync. |
| Machine 2 already has its own vault | Dialog with three choices, default **A**: (A) back up the local vault, then import its entries into the synced vault (asks the local vault's password once; identical logins are skipped, differing ones are kept as "Name (This PC)"); (B) back up the local vault to a file only, then use the synced vault; (C) cancel. |
| Google Cloud project | Created and owned by the maintainer (personal Gmail). See `design/google-cloud-setup.md`. Development may use test credentials until then. |
| Release | **0.9.0** |

## Prior art in this repo

Cloud sync (Google Drive + Telegram) existed before v0.6.0 and was removed in `6d5892e` ("remove cloud sync and
backup") when the vault became a single `vault.nqdb`. Useful references at `6d5892e^`:

- `src-tauri/src/gdrive.rs`: OAuth for desktop (loopback `127.0.0.1:<random>` redirect, PKCE S256, state check,
  callback page, 180 s login timeout), refresh token in the OS keychain via `keyring`, `appDataFolder` REST calls.
  It used client ID `639536443788-jo6ec87mf9qfafpbb1qqskoj0gca8jra.apps.googleusercontent.com` with the secret from
  `NOTIQ_GOOGLE_CLIENT_SECRET` at build time; the maintainer should confirm whether that project still exists.
- `src-tauri/src/sync.rs`: the old whole-file sync. **Do not** reuse its merge model; it predates the entry model below.

`reqwest` (rustls) and `keyring` are still dependencies. `docs/privacy.html` still describes the old Telegram + Drive
sync and must be rewritten for this design.

## Current vault model (what we build on)

`src-tauri/src/vault_db.rs`: `Db { v, entries: BTreeMap<String, Entry>, … }`; each `Entry` has a stable `id`, `path`,
`ext`, `content`, `updated`, `deleted`, `dir`, `tags`, `starred`, `trashed_at`, `history: Vec<Revision>` (last 10)
and `attachments: Vec<Attachment>` (each with its own `id`). The vault key is unwrapped from `VaultMeta` (app-data
folder, not the vault folder) with the master password or the recovery key; Windows Hello wraps the same key per device.

## Architecture

```
Sync / backup ENGINE (once)
  encryption · merge · conflict → history · tombstones · HLC · rollback protection ·
  retention · local safety backups · scheduling · retry/backoff
        │  StorageProvider trait (list / get / put / delete + capabilities)
GoogleDrive (0.9.0) · InMemory (tests) · later: Folder, OneDrive, WebDAV/S3/custom, Telegram (backup-only)
```

### StorageProvider

```rust
#[async_trait]
pub trait StorageProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities;            // overwrite, delete, max_object_bytes
    async fn list(&self, prefix: &str) -> Result<Vec<RemoteObject>, ProviderError>;
    async fn get(&self, name: &str) -> Result<Vec<u8>, ProviderError>;
    async fn put(&self, name: &str, data: &[u8]) -> Result<RemoteObject, ProviderError>;
    async fn delete(&self, name: &str) -> Result<(), ProviderError>;
}
pub enum ProviderError { Auth, NotFound, RateLimited { retry_after_s: u64 }, Offline, TooLarge, Other(String) }
```

- Providers see **only opaque encrypted bytes and opaque names**. They never see entries, keys or plaintext.
- Connect / disconnect / account label are a separate `ProviderAuth` part; secrets live in the OS keychain; all
  network calls happen in Rust (tokens never reach the webview).
- A provider without `overwrite` or `delete` runs in **backup-only** mode (no live sync); the UI says so.
- A shared **contract test suite** every provider must pass; the engine is tested against `InMemoryProvider` with
  fault injection (offline, partial upload, rate limit, stale/rolled-back object).

### Remote layout (inside the provider's app area, e.g. Drive `appDataFolder`)

```
vault.meta                 KDF params, salt, password-wrapped key, recovery-wrapped key, vault_id, meta generation
devices/<deviceId>.nqs     one snapshot per device, written ONLY by that device
blobs/<hash>               attachment payloads, content-addressed, uploaded once
```

- Every object is sealed with the vault key (AEAD). The associated data binds `vault_id`, object kind, `deviceId` and
  generation, so objects can't be swapped between vaults/devices or replayed.
- Names are random/opaque; no entry names, paths or counts leak beyond object sizes.
- Each device keeps the highest generation it has seen per device and **rejects lower ones** (rollback protection).

### Merge (pure, deterministic)

- Each entry change gets a hybrid logical clock stamp `(wall_ms, counter, deviceId)`; merging is per entry by `id`
  (so rename + edit on different devices both survive).
- Higher stamp wins; the losing content is appended to the winner's `history` as a revision marked
  `conflict: from <device name>` (respecting the existing history cap, conflicts are never the first to be dropped).
- Deletes and trash are stamped tombstones; a delete concurrent with an edit resolves to the edit. Tombstones are kept
  well past the 30-day trash purge (proposal: 180 days) and a device that was offline longer does a full re-merge.
- Attachments merge by attachment `id` (union; removals are stamped).
- Properties to test: commutative, associative, idempotent, and **no revision lost** (every input version is either the
  winner or present in history) — property-based tests plus two/three-device simulations.

### Engine behaviour

- Sync runs only while the vault is unlocked (merging needs the key): on unlock, ~5 s after a local change (debounced),
  every 5 min while open, and a final push before lock. Offline changes queue and go out later.
- Before the first sync and before applying a large remote change, write a local `.nqbackup` safety copy (keep 5).
- Password change re-wraps the same key → new `vault.meta` (higher generation); other devices pick it up and show
  "Your master password was changed on another device" when the old one is entered.
  Two concurrent changes (e.g. one PC offline): the later change wins by its `changed_at_ms` / `changed_by` stamp
  (0.9.0 decision 1); an older `vault.meta` that is not a concurrent change is still rejected (see `engine::sync_meta`).
- Windows Hello / PC sign-in stays per device and is never synced. The recovery key is the same on all devices.

## User experience

- **Settings → Vault → Sync**: provider (Google Drive only in 0.9.0), Connect / Disconnect, account, last synced, Sync now,
  devices list (name, last seen; remove), attachment limits, link to Google's permissions page.
- **Vault setup screen**: new "Use my vault from Google Drive" → Google sign-in → master password → download.
  If a different local vault exists: the A/B/C dialog above.
- **Status bar** sync indicator (synced / syncing / problem) and one notification per sync that resolved conflicts.
- `docs/privacy.html` rewritten for this design (Drive only, `drive.appdata`, what is stored, how to revoke).

## Phases

| Phase | Work | Depends on |
|---|---|---|
| P0 Foundation | HLC stamps + device id on entries/attachments, tombstone rules, sync metadata in `vault.nqdb` with migration and `.v1.bak`-style safety copy | — |
| P1 Merge engine | Pure Rust merge + property tests + device simulations | P0 |
| P2 Providers | `StorageProvider` trait, contract tests, `InMemoryProvider`, `GoogleDriveProvider` (OAuth PKCE loopback, keychain, `appDataFolder`, resumable upload, retry/backoff) | P0 (types only) |
| P3 Orchestrator | Sealing/AEAD layout, generations/rollback, scheduling, meta sync, new-device flow, machine-2 import (A/B/C), safety backups | P1, P2 |
| P4 UI | Settings → Sync, setup option, status bar, conflict notice, limits text, What's New, privacy page | P2/P3 (mock first) |
| P5 QA | Two-device runs, offline / crash mid-upload / skewed clocks / password change / revoke access | all |

P1 and P2 can run in parallel after P0; P4 can start against mocks. Each phase on its own branch, reviewed and merged
into `release/0.9.0` by the coordinator; nothing merges to `main` until the release.
