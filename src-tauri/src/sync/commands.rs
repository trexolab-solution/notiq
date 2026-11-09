//! Vault Sync P3: Tauri commands, events and the scheduler (thin glue over `engine`).
//!
//! Scheduling (only while the vault is unlocked and sync is on): soon after unlock, ~5 s after a
//! local change (debounced), every 5 minutes, and a best-effort push (≤ 10 s) before lock. One
//! sync at a time (`run`); retryable failures back off (`RateLimited` honours its delay).
//! Contract: the coordinator's `sync-p3-p4-contract.md`.

pub mod history_cmd; // Drive version history commands (sync_history_list / sync_history_restore)

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use futures_util::future::{select, Either};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroizing;

use super::engine::{self, CycleOpts, Ctx, DeviceRow, LocalVault, Mode, Outcome, PendingDeletions, SyncError, SyncResult};
use super::gdrive::{self, GoogleDriveProvider, OAuthClient, UrlOpener};
use super::provider::{ProviderAuth, ProviderError, StorageProvider};
use super::seal;
use super::state::{self, SyncState};
use crate::vault::{self, VaultState};
use crate::vault_core::{self as vc, VaultError, VaultMeta};
use crate::vault_db::{self as vdb, Db};

pub const STATUS_EVENT: &str = "vault-sync://status";
pub const CONFLICTS_EVENT: &str = "vault-sync://conflicts";
pub const CHANGED_EVENT: &str = "vault-sync://changed";

const DEBOUNCE: Duration = Duration::from_secs(5);
const AFTER_UNLOCK: Duration = Duration::from_secs(1);
const PERIOD: Duration = Duration::from_secs(5 * 60);
const FINAL_PUSH: Duration = Duration::from_secs(10);
const BACKOFF_MIN_S: u64 = 30;

// ─── types (contract) ────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    configured: bool,
    provider: Option<String>,
    account: Option<String>,
    enabled: bool,
    state: &'static str,
    last_synced_ms: Option<u64>,
    last_error: Option<String>,
    pending: bool,
    device_id: String,
    device_name: String,
    /// Set while `state` is `"awaitingConfirm"`: the upload the outbound guard stopped.
    pending_deletions: Option<PendingDeletions>,
}

/// What `sync_apply_deletions` / `sync_restore_from_drive` did.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardChoiceResult {
    /// The copy of the store's state written first (apply), or of it before the join (restore).
    backup_path: Option<String>,
    result: SyncResult,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteVaultInfo {
    exists: bool,
    same_vault: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptResult {
    backup_path: String,
    imported: usize,
    skipped: usize,
    renamed: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Idle,
    Syncing,
    Offline,
    Error,
    AuthNeeded,
    /// The outbound guard stopped an upload; waiting for the user's choice.
    AwaitingConfirm,
}

#[derive(Default)]
struct Sched {
    debounce: Option<Instant>,
    periodic: Option<Instant>,
    backoff: Option<Instant>,
    backoff_s: u64,
}

// ─── manager ─────────────────────────────────────────────────────────────────

pub struct SyncManager {
    state: Mutex<SyncState>,
    dir: Mutex<Option<PathBuf>>,
    phase: Mutex<Phase>,
    drive: Mutex<Option<Arc<GoogleDriveProvider>>>,
    /// Single flight: held for the whole cycle.
    run: tokio::sync::Mutex<()>,
    wake: tokio::sync::Notify,
    sched: Mutex<Sched>,
    /// A local change happened since the running cycle started.
    dirty: AtomicBool,
    /// Cancels the sign-in that is still waiting when `sync_connect` is called again.
    connect_cancel: Mutex<Option<Arc<tokio::sync::Notify>>>,
    /// The upload the outbound guard stopped (memory only; the next cycle finds it again).
    pending_deletions: Mutex<Option<PendingDeletions>>,
}

impl Default for SyncManager {
    fn default() -> Self {
        SyncManager {
            state: Mutex::new(SyncState::default()),
            dir: Mutex::new(None),
            phase: Mutex::new(Phase::Idle),
            drive: Mutex::new(None),
            run: tokio::sync::Mutex::new(()),
            wake: tokio::sync::Notify::new(),
            sched: Mutex::new(Sched::default()),
            dirty: AtomicBool::new(false),
            connect_cancel: Mutex::new(None),
            pending_deletions: Mutex::new(None),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl SyncManager {
    fn st(&self) -> MutexGuard<'_, SyncState> {
        lock(&self.state)
    }

    fn save(&self) {
        let dir = lock(&self.dir).clone();
        if let Some(d) = dir {
            if let Err(e) = self.st().save(&d) {
                eprintln!("[sync] couldn't save {}: {e}", state::STATE_FILE);
            }
        }
    }

    fn set_phase(&self, p: Phase) {
        *lock(&self.phase) = p;
    }

    fn device_name(&self) -> String {
        self.st().device_name.clone().unwrap_or_else(state::host_name)
    }

    /// This installation's device id: the SAME id the engine names its own snapshot with
    /// (`devices/<id>.nqs`). Loads it from app data first if that hasn't happened yet, so it is
    /// never missing (or a different session-only id) in states like right after a join.
    fn device_id(&self, app: &AppHandle) -> Option<String> {
        let vault = app.state::<VaultState>();
        if vault.device_id().is_none() {
            if let Ok(dir) = app.path().app_data_dir() {
                vault.ensure_device(&dir);
            }
        }
        vault.device_id()
    }

    fn drive(&self, app: &AppHandle) -> Result<Arc<GoogleDriveProvider>, String> {
        let mut d = lock(&self.drive);
        if let Some(p) = d.as_ref() {
            return Ok(p.clone());
        }
        let h = app.clone();
        let opener: UrlOpener = Arc::new(move |url: &str| h.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()));
        let p = Arc::new(GoogleDriveProvider::production(Some(opener)).map_err(|e| e.to_string())?);
        *d = Some(p.clone());
        Ok(p)
    }

    fn connected_drive(&self, app: &AppHandle) -> Result<Arc<GoogleDriveProvider>, String> {
        if self.st().provider.is_none() {
            return Err(engine::ERR_NOT_CONNECTED.into());
        }
        self.drive(app)
    }

    fn kick(&self, after: Duration) {
        {
            let mut s = lock(&self.sched);
            let at = Instant::now() + after;
            s.debounce = Some(s.debounce.map_or(at, |d| d.min(at)));
        }
        self.wake.notify_one();
    }

    /// When the scheduler should run next (`None` = wait for a wake-up).
    fn next_due(&self, active: bool) -> Option<Instant> {
        if !active {
            return None;
        }
        let mut s = lock(&self.sched);
        let now = Instant::now();
        let periodic = *s.periodic.get_or_insert(now + PERIOD);
        let due = s.debounce.map_or(periodic, |d| d.min(periodic));
        Some(match s.backoff {
            Some(b) if b > due => b,
            _ => due,
        })
    }
}

fn configured() -> bool {
    OAuthClient::from_build().is_some()
}

fn status_of(app: &AppHandle) -> SyncStatus {
    let mgr = app.state::<SyncManager>();
    let vault = app.state::<VaultState>();
    let unlocked = vault.is_unlocked();
    let device_id = mgr.device_id(app).unwrap_or_default();
    let device_name = mgr.device_name();
    let phase = *lock(&mgr.phase);
    let st = mgr.st();
    let state = if !st.enabled {
        "off"
    } else if !unlocked {
        "locked"
    } else {
        match phase {
            Phase::Idle => "idle",
            Phase::Syncing => "syncing",
            Phase::Offline => "offline",
            Phase::Error => "error",
            Phase::AuthNeeded => "authNeeded",
            Phase::AwaitingConfirm => "awaitingConfirm",
        }
    };
    let pending_deletions = if state == "awaitingConfirm" { lock(&mgr.pending_deletions).clone() } else { None };
    SyncStatus {
        configured: configured(),
        provider: st.provider.clone(),
        account: st.account.clone(),
        enabled: st.enabled,
        state,
        last_synced_ms: st.last_synced_ms,
        last_error: st.last_error.clone(),
        pending: st.pending,
        device_id,
        device_name,
        pending_deletions,
    }
}

/// Emits `vault-sync://status`.
pub(crate) fn notify_status(app: &AppHandle) {
    if app.try_state::<SyncManager>().is_some() {
        let _ = app.emit(STATUS_EVENT, status_of(app));
    }
}

// ─── the local vault for the engine ──────────────────────────────────────────

struct TauriLocal<'a> {
    app: &'a AppHandle,
    vault: &'a VaultState,
}

impl LocalVault for TauriLocal<'_> {
    fn read_db<T>(&self, f: impl FnOnce(&Db) -> T) -> Result<T, String> {
        self.vault.with_db_quiet(|db, _, _, _| Ok((f(db), false)))
    }
    fn update_db<T>(&self, f: impl FnOnce(&mut Db) -> (T, bool)) -> Result<T, String> {
        self.vault.with_db_quiet(|db, _, _, _| Ok(f(db)))
    }
    fn meta(&self) -> Result<VaultMeta, String> {
        vault::require_meta(self.app)
    }
    fn adopt_meta(&self, meta: &VaultMeta) -> Result<(), String> {
        vault::adopt_meta(self.app, meta)
    }
    fn safety_backup(&self, reason: &str) -> Result<Option<PathBuf>, String> {
        let Some(root) = self.vault.root() else { return Ok(None) };
        let Ok(db) = std::fs::read(vdb::db_path(&root)) else { return Ok(None) };
        let meta = std::fs::read(vault::meta_path(self.app)?).map_err(|e| e.to_string())?;
        let dir = self.app.path().app_data_dir().map_err(|e| e.to_string())?;
        state::write_safety_backup(&dir, &meta, &db, reason, vdb::now_ms()).map(Some)
    }
    fn change_seq(&self) -> u64 {
        self.vault.change_seq()
    }
    fn remote_backup(&self, db: &Db, reason: &str) -> Result<Option<PathBuf>, String> {
        let Some((key, vault_id)) = self.vault.key_copy() else { return Ok(None) };
        let sealed = db.seal(&key, &vault_id)?;
        drop(key);
        let meta = std::fs::read(vault::meta_path(self.app)?).map_err(|e| e.to_string())?;
        let dir = self.app.path().app_data_dir().map_err(|e| e.to_string())?;
        state::write_safety_backup(&dir, &meta, &sealed, reason, vdb::now_ms()).map(Some)
    }
}

/// Where safety backups go (shown in the guard dialog).
fn backup_dir(app: &AppHandle) -> String {
    app.path().app_data_dir().map(|d| d.join(state::SAFETY_DIR).to_string_lossy().into_owned()).unwrap_or_default()
}

// ─── cycle ───────────────────────────────────────────────────────────────────

fn phase_for(e: &SyncError) -> Phase {
    match e {
        SyncError::Provider(ProviderError::Auth) => Phase::AuthNeeded,
        SyncError::Provider(ProviderError::Offline) => Phase::Offline,
        _ => Phase::Error,
    }
}

/// Runs one cycle. `wait = false` (scheduler) skips when one is already running; precondition
/// failures then return `Ok(None)` quietly.
async fn run_cycle(app: &AppHandle, mode: Mode, wait: bool) -> Result<Option<SyncResult>, String> {
    Ok(run_cycle_with(app, mode, wait, CycleOpts::default()).await?.map(|(r, _)| r))
}

/// [`run_cycle`] with the user's choices; also returns the store-state backup it wrote.
async fn run_cycle_with(app: &AppHandle, mode: Mode, wait: bool, opts: CycleOpts) -> Result<Option<(SyncResult, Option<PathBuf>)>, String> {
    let mgr = app.state::<SyncManager>();
    let vault = app.state::<VaultState>();
    let _guard = if wait {
        mgr.run.lock().await
    } else {
        match mgr.run.try_lock() {
            Ok(g) => g,
            Err(_) => return Ok(None),
        }
    };
    let quiet = |e: &str| if wait { Err(e.to_string()) } else { Ok(None) };
    let (enabled, connected, vault_hex) = {
        let st = mgr.st();
        (st.enabled, st.provider.is_some(), st.vault_id.clone())
    };
    if !connected {
        return quiet(engine::ERR_NOT_CONNECTED);
    }
    if !enabled {
        return quiet("Sync is turned off on this device.");
    }
    let Some((key, vault_id)) = vault.key_copy() else { return quiet(engine::ERR_LOCKED) };
    if vault_hex.as_deref() != Some(seal::vault_id_hex(&vault_id).as_str()) {
        // vault.json was replaced (new vault, restored backup): never push it over the synced one.
        let msg = "Sync was turned off because this device now has a different vault. Turn it on again in Settings.";
        {
            let mut st = mgr.st();
            st.enabled = false;
            st.last_error = Some(msg.into());
        }
        mgr.save();
        notify_status(app);
        return quiet(msg);
    }
    let drive = mgr.drive(app)?;
    let device_id = mgr.device_id(app).ok_or("The sync device id isn't set yet")?;
    let device_name = mgr.device_name();
    let mut st = mgr.st().clone();
    let start = Start { meta_gen: st.meta_generation, meta_pending: st.meta_pending, detached: st.detached, resume_guard: st.resume_guard };
    mgr.dirty.store(false, Ordering::SeqCst);
    mgr.set_phase(Phase::Syncing);
    notify_status(app);

    let res = {
        let ctx = Ctx::new(&*drive as &dyn StorageProvider, &key, &vault_id, &device_id, &device_name, vdb::now_ms());
        let local = TauriLocal { app, vault: &vault };
        engine::sync_once_with(&ctx, &local, &mut st, mode, opts).await
    };
    drop(key);
    finish(app, st, res, start)
}

/// Shared-state values when a cycle started (a change made meanwhile is never overwritten).
struct Start {
    meta_gen: u64,
    meta_pending: bool,
    detached: bool,
    resume_guard: bool,
}

fn finish(app: &AppHandle, st: SyncState, res: Result<Outcome, SyncError>, start: Start) -> Result<Option<(SyncResult, Option<PathBuf>)>, String> {
    let (meta_gen0, meta_pending0) = (start.meta_gen, start.meta_pending);
    let mgr = app.state::<SyncManager>();
    let dirty = mgr.dirty.swap(false, Ordering::SeqCst);
    {
        let mut sh = mgr.st();
        sh.own_generation = st.own_generation;
        sh.seen = st.seen.clone();
        sh.devices = st.devices.clone();
        sh.revisions = st.revisions.clone();
        sh.remote_cache = st.remote_cache.clone();
        sh.meta_revision = st.meta_revision.clone();
        // Only what the cycle itself changed (a disconnect / resume meanwhile wins).
        if st.detached != start.detached && sh.detached == start.detached {
            sh.detached = st.detached;
            sh.detached_at_ms = st.detached_at_ms;
        }
        if st.resume_guard != start.resume_guard && sh.resume_guard == start.resume_guard {
            sh.resume_guard = st.resume_guard;
        }
        sh.first_sync_done = st.first_sync_done;
        if st.last_synced_ms.is_some() {
            sh.last_synced_ms = st.last_synced_ms;
        }
        sh.meta_synced_generation = st.meta_synced_generation;
        if sh.meta_generation == meta_gen0 && sh.meta_pending == meta_pending0 {
            sh.meta_generation = st.meta_generation;
            sh.meta_pending = st.meta_pending;
        } else {
            // The password was changed here during the cycle: keep that change pending, above.
            sh.meta_generation = sh.meta_generation.max(st.meta_generation + 1);
        }
        sh.pending = st.pending || dirty;
    }
    let mut s = lock(&mgr.sched);
    s.periodic = Some(Instant::now() + PERIOD);
    let out = match res {
        Ok(mut o) => {
            super::markers::record_after_sync(app, std::mem::take(&mut o.markers));
            let err = o.upload_error.clone();
            let msg = match &err {
                Some(e) => Some(e.describe()),
                None if o.warnings.is_empty() => None,
                None => Some(o.warnings.join(" ")),
            };
            mgr.st().last_error = msg;
            let guard = o.pending_deletions.clone().map(|mut p| {
                p.backup_dir = backup_dir(app);
                p
            });
            match (&err, &guard) {
                (Some(e), _) => {
                    backoff(&mut s, e);
                    mgr.set_phase(phase_for(e));
                }
                (None, Some(_)) => {
                    s.backoff = None;
                    s.backoff_s = 0;
                    mgr.set_phase(Phase::AwaitingConfirm);
                }
                (None, None) => {
                    s.backoff = None;
                    s.backoff_s = 0;
                    mgr.set_phase(Phase::Idle);
                }
            }
            if err.is_none() {
                *lock(&mgr.pending_deletions) = guard;
            }
            if o.changed_local || o.meta_adopted {
                let _ = app.emit(CHANGED_EVENT, serde_json::json!({}));
            }
            if !o.result.conflicts.is_empty() {
                let _ = app.emit(CONFLICTS_EVENT, serde_json::json!({ "conflicts": o.result.conflicts }));
            }
            Ok(Some((o.result, o.remote_backup)))
        }
        Err(e) => {
            backoff(&mut s, &e);
            mgr.set_phase(phase_for(&e));
            {
                let mut st = mgr.st();
                st.last_error = Some(e.describe());
                if e == SyncError::RemoteVaultDifferent {
                    st.enabled = false;
                }
            }
            Err(e.message())
        }
    };
    drop(s);
    mgr.save();
    notify_status(app);
    out
}

fn backoff(s: &mut Sched, e: &SyncError) {
    let secs = match e {
        SyncError::Provider(ProviderError::RateLimited { retry_after_s }) => (*retry_after_s).max(1),
        SyncError::Provider(ProviderError::Auth) | SyncError::RemoteVaultDifferent => PERIOD.as_secs(),
        _ => (s.backoff_s * 2).clamp(BACKOFF_MIN_S, PERIOD.as_secs()),
    };
    s.backoff_s = secs;
    s.backoff = Some(Instant::now() + Duration::from_secs(secs));
}

// ─── lifecycle hooks (called from vault.rs / hello.rs / lib.rs) ──────────────

/// App start: load the per-device settings, hook local changes, start the scheduler.
pub fn start(app: &AppHandle) {
    let mgr = app.state::<SyncManager>();
    if let Ok(dir) = app.path().app_data_dir() {
        app.state::<VaultState>().ensure_device(&dir);
        *mgr.st() = SyncState::load(&dir);
        *lock(&mgr.dir) = Some(dir);
    }
    let h = app.clone();
    app.state::<VaultState>().set_change_hook(Box::new(move || on_local_change(&h)));
    let h = app.clone();
    tauri::async_runtime::spawn(async move { scheduler(h).await });
}

async fn scheduler(app: AppHandle) {
    loop {
        let active = {
            let mgr = app.state::<SyncManager>();
            let st = mgr.st();
            st.enabled && st.provider.is_some()
        } && app.state::<VaultState>().is_unlocked();
        let due = app.state::<SyncManager>().next_due(active);
        let mgr = app.state::<SyncManager>();
        match due {
            None => {
                mgr.wake.notified().await;
                continue;
            }
            Some(t) => {
                let woke = mgr.wake.notified();
                let timer = tokio::time::sleep_until(tokio::time::Instant::from_std(t));
                if let Either::Left(_) = select(Box::pin(woke), Box::pin(timer)).await {
                    continue;
                }
            }
        }
        lock(&mgr.sched).debounce = None;
        let _ = run_cycle(&app, Mode::Full, false).await;
    }
}

fn on_local_change(app: &AppHandle) {
    let mgr = app.state::<SyncManager>();
    mgr.dirty.store(true, Ordering::SeqCst);
    let newly = {
        let mut st = mgr.st();
        if !st.enabled {
            return;
        }
        let newly = !st.pending;
        st.pending = true;
        newly
    };
    if newly {
        mgr.save();
        notify_status(app);
    }
    mgr.kick(DEBOUNCE);
}

/// After any unlock: full re-merge soon.
pub(crate) fn on_unlocked(app: &AppHandle) {
    let Some(mgr) = app.try_state::<SyncManager>() else { return };
    mgr.st().forget_revisions();
    if mgr.st().enabled {
        mgr.kick(AFTER_UNLOCK);
    }
    notify_status(app);
}

/// After the master password changed on this device: upload the new vault.meta.
pub(crate) fn on_local_meta_changed(app: &AppHandle) {
    vault::clear_prev_meta(app);
    let Some(mgr) = app.try_state::<SyncManager>() else { return };
    let vault_hex = app.state::<VaultState>().key_copy().map(|(_, id)| seal::vault_id_hex(&id));
    let enabled = {
        let mut st = mgr.st();
        // Sync on, or paused for this same vault: the change is uploaded on the next cycle, and
        // against a concurrent change made elsewhere the later change wins (engine::sync_meta).
        // Another vault's sync state (or none) has nothing to do with this change.
        let ours = vault_hex.is_some() && st.vault_id == vault_hex;
        if !st.note_local_meta_change(ours) {
            return;
        }
        st.enabled
    };
    mgr.save();
    if enabled {
        mgr.kick(AFTER_UNLOCK);
    }
}

/// Best-effort final push (≤ 10 s) before the vault locks.
pub(crate) async fn before_lock(app: &AppHandle) {
    let Some(mgr) = app.try_state::<SyncManager>() else { return };
    let go = {
        let st = mgr.st();
        st.enabled && st.provider.is_some() && (st.pending || st.meta_pending)
    } && app.state::<VaultState>().is_unlocked();
    if go {
        let _ = tokio::time::timeout(FINAL_PUSH, run_cycle(app, Mode::PushOnly, true)).await;
    }
}

// ─── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn sync_status(app: AppHandle) -> SyncStatus {
    status_of(&app)
}

#[tauri::command]
pub async fn sync_connect(app: AppHandle) -> Result<SyncStatus, String> {
    if !configured() {
        return Err(engine::ERR_NOT_CONFIGURED.into());
    }
    let mgr = app.state::<SyncManager>();
    let drive = mgr.drive(&app)?;
    // A second call while the first still waits for the browser replaces it (its loopback listener
    // is dropped with its future); the earlier call returns "cancelled", which the UI ignores.
    let cancel = Arc::new(tokio::sync::Notify::new());
    if let Some(old) = lock(&mgr.connect_cancel).replace(cancel.clone()) {
        old.notify_one();
    }
    let res = match select(drive.connect(), Box::pin(cancel.notified())).await {
        Either::Left((r, _)) => Some(r),
        Either::Right(_) => None, // replaced by a newer sign-in; dropping connect() frees its listener
    };
    {
        let mut c = lock(&mgr.connect_cancel);
        if c.as_ref().is_some_and(|x| Arc::ptr_eq(x, &cancel)) {
            *c = None;
        }
    }
    let account = match res {
        None => return Err("Google sign-in was cancelled.".into()),
        Some(Err(ProviderError::Other(m))) if m == gdrive::NOT_CONFIGURED => return Err(engine::ERR_NOT_CONFIGURED.into()),
        Some(Err(e)) => return Err(SyncError::Provider(e).message()),
        Some(Ok(a)) => a,
    };
    {
        let mut st = mgr.st();
        // Signed out before detaching existed (an older version's Disconnect): treat it as detached.
        if st.provider.is_none() && st.vault_id.is_some() && !st.enabled && !st.detached {
            st.detached = true;
        }
        st.provider = Some(gdrive::PROVIDER_ID.into());
        st.account = Some(account.label);
        st.last_error = None;
    }
    mgr.set_phase(Phase::Idle);
    mgr.save();
    if mgr.st().enabled {
        mgr.kick(AFTER_UNLOCK);
    }
    notify_status(&app);
    Ok(status_of(&app))
}

/// Signs out (revokes, clears the keychain) and turns sync off. Remote data is never deleted.
#[tauri::command]
pub async fn sync_disconnect(app: AppHandle) -> Result<(), String> {
    let mgr = app.state::<SyncManager>();
    let drive = lock(&mgr.drive).take();
    let drive = match drive {
        Some(d) => Some(d),
        None => GoogleDriveProvider::production(None).ok().map(Arc::new),
    };
    if let Some(d) = drive {
        let _ = d.disconnect().await; // best effort revoke; the keychain entry is cleared either way
    }
    {
        let mut st = mgr.st();
        st.provider = None;
        st.account = None;
        st.enabled = false;
        st.last_error = None;
        st.forget_revisions();
        // Detach: whatever happens here from now on, reconnecting makes Google Drive the source of
        // truth again (a Drive-first join, see engine::sync_once_with), never a silent push.
        if st.vault_id.is_some() {
            st.detached = true;
            st.detached_at_ms = Some(vdb::now_ms());
        }
        st.resume_guard = false;
    }
    *lock(&mgr.pending_deletions) = None;
    mgr.set_phase(Phase::Idle);
    mgr.save();
    notify_status(&app);
    Ok(())
}

#[tauri::command]
pub async fn sync_remote_info(app: AppHandle) -> Result<RemoteVaultInfo, String> {
    let drive = app.state::<SyncManager>().connected_drive(&app)?;
    let remote = engine::fetch_meta(&*drive).await.map_err(|e| e.message())?;
    let local = vault::load_meta(&app)?;
    Ok(match remote {
        None => RemoteVaultInfo { exists: false, same_vault: None },
        Some(rm) => RemoteVaultInfo { exists: true, same_vault: local.map(|l| l.vault_id == rm.meta.vault_id) },
    })
}

#[tauri::command]
pub async fn sync_enable(app: AppHandle) -> Result<SyncResult, String> {
    let mgr = app.state::<SyncManager>();
    let drive = mgr.connected_drive(&app)?;
    let vault_state = app.state::<VaultState>();
    let Some((_, vault_id)) = vault_state.key_copy() else { return Err(engine::ERR_LOCKED.into()) };
    let hex = seal::vault_id_hex(&vault_id);
    let remote = engine::fetch_meta(&*drive).await.map_err(|e| e.message())?;
    // vault.meta: a newer synced one is adopted in the cycle below; a password change made here
    // while paused competes with a concurrent one by "the later change wins" (engine::sync_meta).
    engine::prepare_enable(&mut mgr.st(), &hex, remote.as_ref()).map_err(|e| e.message())?;
    mgr.save();
    let r = run_cycle(&app, Mode::Full, true).await?;
    Ok(r.unwrap_or_default())
}

fn map_wrong_password(e: String) -> String {
    if e == VaultError::WrongPassword.to_string() {
        SyncError::WrongPassword.message()
    } else {
        e
    }
}

/// New device: download vault.meta, unlock it with the password, set up the vault from the store.
#[tauri::command]
pub async fn sync_join(app: AppHandle, window: tauri::Window, password: String) -> Result<(), String> {
    let mgr = app.state::<SyncManager>();
    let drive = mgr.connected_drive(&app)?;
    if vault::load_meta(&app)?.is_some() {
        return Err("A vault already exists on this device.".into());
    }
    let rm = engine::fetch_meta(&*drive).await.map_err(|e| e.message())?.ok_or(engine::ERR_NO_REMOTE)?;
    let vault_state = app.state::<VaultState>();
    let m = rm.meta.clone();
    let password = Zeroizing::new(password);
    let key = vault::guarded(&vault_state, move || vc::unlock_with_password(&m, &password)).await.map_err(map_wrong_password)?;
    let device_id = mgr.device_id(&app).ok_or("The sync device id isn't set yet")?;
    // Everything is downloaded and verified in memory first: on failure nothing local changes.
    let prep = engine::prepare_switch(&*drive, &rm, &key, &device_id, &mgr.device_name(), vdb::now_ms(), None)
        .await
        .map_err(|e| e.message())?;
    let vault_id = rm.vault_id().ok_or("The synced vault key file is invalid.")?;

    let root = match vault_state.root() {
        Some(r) => r,
        None => {
            let r = PathBuf::from(vault::vault_default_dir(app.clone())?);
            vault_state.set_root(r.clone());
            r
        }
    };
    let stray = vdb::db_path(&root);
    if stray.exists() {
        // A database without its vault.json can't be opened; keep it aside, never overwrite it.
        let aside = root.join(format!("{}.before-join-{}", vdb::DB_FILE, vdb::now_ms()));
        std::fs::rename(&stray, &aside).map_err(|e| e.to_string())?;
    }
    let mut db = prep.db;
    vault_state.lock_all();
    vdb::save_db(&root, &mut db, &key, &vault_id)?; // the database first, then the key file
    drop(db);
    vault::save_meta(&app, &rm.meta)?;
    vault::clear_prev_meta(&app);
    crate::hello::invalidate(&app);
    install_switched_state(&mgr, prep.state, prep.warnings);
    vault_state.install_key(key, vault_id);
    vault::notify_state(&app, true, window.label());
    // Uploads this device's snapshot; a failure only leaves it pending.
    let _ = run_cycle(&app, Mode::Full, true).await;
    let _ = app.emit(CHANGED_EVENT, serde_json::json!({}));
    notify_status(&app);
    Ok(())
}

/// After join / adopt: this device's sync state for the newly installed vault.
fn install_switched_state(mgr: &SyncManager, fresh: SyncState, warnings: Vec<String>) {
    {
        let mut st = mgr.st();
        let own = st.own_generation.max(fresh.own_generation);
        let (provider, account, name) = (st.provider.take(), st.account.take(), st.device_name.take());
        *st = fresh;
        st.own_generation = own;
        st.provider = provider;
        st.account = account;
        st.device_name = name;
        st.last_error = (!warnings.is_empty()).then(|| warnings.join(" "));
    }
    mgr.save();
}

/// Machine 2 that already has its own vault: back it up, then switch to the synced vault,
/// importing this PC's entries (`import`) or not (`backupOnly`).
#[tauri::command]
pub async fn sync_adopt_remote(
    app: AppHandle,
    window: tauri::Window,
    remote_password: String,
    mode: String,
    local_password: Option<String>,
) -> Result<AdoptResult, String> {
    let import = match mode.as_str() {
        "import" => true,
        "backupOnly" => false,
        _ => return Err("Unknown mode".into()),
    };
    let mgr = app.state::<SyncManager>();
    let drive = mgr.connected_drive(&app)?;
    let local_meta = vault::require_meta(&app)?;
    let rm = engine::fetch_meta(&*drive).await.map_err(|e| e.message())?.ok_or(engine::ERR_NO_REMOTE)?;
    let vault_state = app.state::<VaultState>();
    let m = rm.meta.clone();
    let pw = Zeroizing::new(remote_password);
    let remote_key = vault::guarded(&vault_state, move || vc::unlock_with_password(&m, &pw)).await.map_err(map_wrong_password)?;
    let remote_id = engine::verify_meta(&rm, &remote_key).map_err(|e| e.message())?;

    // This PC's vault, decrypted.
    let root = vault_state.root().ok_or("The vault folder isn't set yet")?;
    let local_id = local_meta.vault_id_bytes().map_err(|e| e.to_string())?;
    let local_db: Db = if vault_state.is_unlocked() {
        vault_state.with_db_quiet(|db, _, _, _| Ok((db.clone(), false)))?
    } else {
        let lp = Zeroizing::new(local_password.ok_or(engine::ERR_LOCKED)?);
        let lm = local_meta.clone();
        let lk = vault::guarded(&vault_state, move || vc::unlock_with_password(&lm, &lp)).await.map_err(map_wrong_password)?;
        vdb::load(&root, &lk, &local_id)?
    };

    // Always keep the local vault in a file first.
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let meta_bytes = std::fs::read(vault::meta_path(&app)?).map_err(|e| e.to_string())?;
    let db_bytes = match std::fs::read(vdb::db_path(&root)) {
        Ok(b) => b,
        Err(_) => {
            let (lk, _) = vault_state.key_copy().ok_or("The vault database is missing")?;
            local_db.seal(&lk, &local_id)?
        }
    };
    let backup = state::write_local_vault_backup(&app_data, &meta_bytes, &db_bytes, vdb::now_ms())?;

    if local_id == remote_id {
        // Already the same vault: a normal sync merges it.
        sync_enable(app.clone()).await?;
        return Ok(AdoptResult { backup_path: backup.to_string_lossy().into_owned(), imported: 0, skipped: 0, renamed: 0 });
    }

    let device_id = mgr.device_id(&app).ok_or("The sync device id isn't set yet")?;
    // Download, verify and merge in memory first: on failure this PC's vault stays as it was
    // (usable with its own password) and sync stays off; only the backup file remains.
    let prep = engine::prepare_switch(&*drive, &rm, &remote_key, &device_id, &mgr.device_name(), vdb::now_ms(), import.then_some(&local_db))
        .await
        .map_err(|e| e.message())?;
    drop(local_db);
    let counts = prep.counts.clone();

    // Switch this device to the synced vault.
    let mut db = prep.db;
    vault_state.lock_all();
    vault::notify_state(&app, false, window.label());
    vdb::save_db(&root, &mut db, &remote_key, &remote_id)?;
    drop(db);
    vault::save_meta(&app, &rm.meta)?;
    vault::clear_prev_meta(&app);
    crate::hello::invalidate(&app); // per-device Hello was for the old key
    let warnings = prep.warnings;
    install_switched_state(&mgr, prep.state, warnings.clone());
    vault_state.install_key(remote_key, remote_id);
    vault::notify_state(&app, true, window.label());
    let _ = run_cycle(&app, Mode::Full, true).await;
    if !warnings.is_empty() {
        let mut st = mgr.st();
        let mut msg = warnings.join(" ");
        if let Some(e) = st.last_error.take().filter(|e| *e != msg) {
            msg = format!("{msg} {e}");
        }
        st.last_error = Some(msg);
    }
    mgr.save();
    let _ = app.emit(CHANGED_EVENT, serde_json::json!({}));
    notify_status(&app);
    Ok(AdoptResult {
        backup_path: backup.to_string_lossy().into_owned(),
        imported: counts.imported,
        skipped: counts.skipped,
        renamed: counts.renamed,
    })
}

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<SyncResult, String> {
    if !app.state::<VaultState>().is_unlocked() {
        return Err(engine::ERR_LOCKED.into());
    }
    Ok(run_cycle(&app, Mode::Full, true).await?.unwrap_or_default())
}

#[tauri::command]
pub fn sync_disable(app: AppHandle) -> Result<(), String> {
    let mgr = app.state::<SyncManager>();
    mgr.st().enabled = false;
    *lock(&mgr.pending_deletions) = None;
    mgr.set_phase(Phase::Idle);
    mgr.save();
    notify_status(&app);
    Ok(())
}

/// The guard dialog's "Apply deletions everywhere": backs up the store's state
/// (`remote-before-deletes`) and the local vault, then uploads with the removals.
#[tauri::command]
pub async fn sync_apply_deletions(app: AppHandle) -> Result<GuardChoiceResult, String> {
    guard_choice(&app, CycleOpts { allow_removals: true, drive_first: false }).await
}

/// The guard dialog's "Restore from Drive": a Drive-first cycle (everything live in the store
/// but trashed / deleted here comes back; local edits and adds are kept).
#[tauri::command]
pub async fn sync_restore_from_drive(app: AppHandle) -> Result<GuardChoiceResult, String> {
    guard_choice(&app, CycleOpts { allow_removals: false, drive_first: true }).await
}

async fn guard_choice(app: &AppHandle, opts: CycleOpts) -> Result<GuardChoiceResult, String> {
    if !app.state::<VaultState>().is_unlocked() {
        return Err(engine::ERR_LOCKED.into());
    }
    let (result, backup) = run_cycle_with(app, Mode::Full, true, opts).await?.unwrap_or_default();
    Ok(GuardChoiceResult { backup_path: backup.map(|p| p.to_string_lossy().into_owned()), result })
}

/// Devices with a snapshot in the store. Names never fall back to ids: a device whose name isn't
/// known yet is read from its snapshot while the vault is unlocked, otherwise its name is empty
/// (the UI says "Unnamed device"). `thisDevice` uses the engine's own snapshot id.
#[tauri::command]
pub async fn sync_devices(app: AppHandle) -> Result<Vec<DeviceRow>, String> {
    let mgr = app.state::<SyncManager>();
    let drive = mgr.connected_drive(&app)?;
    let me = mgr.device_id(&app).unwrap_or_default();
    let my_name = mgr.device_name();
    // The key only helps for the vault this device syncs (another vault's snapshots won't open).
    let keys = app.state::<VaultState>().key_copy().and_then(|(key, vault_id)| {
        let ours = mgr.st().vault_id.as_deref() == Some(seal::vault_id_hex(&vault_id).as_str());
        ours.then(|| seal::SyncKeys::derive(&key, &vault_id))
    });
    let mut known = mgr.st().devices.clone();
    let (rows, learned) = engine::list_devices(&*drive, keys.as_ref(), &mut known, &me, &my_name)
        .await
        .map_err(|e| e.message())?;
    if learned {
        {
            let mut st = mgr.st();
            for (id, info) in known {
                st.devices.entry(id).or_insert(info);
            }
        }
        mgr.save();
    }
    Ok(rows)
}

#[tauri::command]
pub async fn sync_remove_device(app: AppHandle, id: String) -> Result<(), String> {
    let mgr = app.state::<SyncManager>();
    let drive = mgr.connected_drive(&app)?;
    if Some(&id) == mgr.device_id(&app).as_ref() {
        return Err("This device can't be removed from here. Turn sync off instead.".into());
    }
    if !crate::vault_hlc::valid_device_id(&id) {
        return Err("Unknown device".into());
    }
    match drive.delete(&seal::device_object(&id)).await {
        Ok(()) | Err(ProviderError::NotFound) => {}
        Err(e) => return Err(SyncError::Provider(e).message()),
    }
    mgr.st().devices.remove(&id);
    mgr.save();
    Ok(())
}

#[tauri::command]
pub fn sync_set_device_name(app: AppHandle, name: String) -> Result<SyncStatus, String> {
    let name = state::clean_device_name(&name)?;
    let mgr = app.state::<SyncManager>();
    let enabled = {
        let mut st = mgr.st();
        st.device_name = Some(name);
        if st.enabled {
            st.pending = true; // the name travels in this device's snapshot
        }
        st.enabled
    };
    if enabled {
        // A cycle running right now uploads the old name and would clear `pending` when it
        // finishes; marking it dirty keeps the rename pending for the next cycle.
        mgr.dirty.store(true, Ordering::SeqCst);
    }
    mgr.save();
    if enabled {
        mgr.kick(DEBOUNCE);
    }
    notify_status(&app);
    Ok(status_of(&app))
}
