//! Tauri commands for Drive version history (`sync_history_list`, `sync_history_restore`).
//! Thin glue over [`crate::sync::history`]; a child of `commands` so it reuses the manager.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

use super::{notify_status, SyncManager, CHANGED_EVENT};
use crate::sync::engine::{self, Ctx, LocalVault, SyncError};
use crate::sync::history::{self, RestorePoint, RestoreSummary};
use crate::sync::provider::StorageProvider;
use crate::sync::seal;
use crate::sync::state;
use crate::vault::{self, VaultState};
use crate::vault_core::VaultMeta;
use crate::vault_db::{self as vdb, Db};

/// The local vault for a restore: unlike the sync engine's own merges, the restore is saved as a
/// normal local change (`with_db`), so the change hook marks sync pending and schedules the cycle
/// that uploads it.
struct RestoreLocal<'a> {
    app: &'a AppHandle,
    vault: &'a VaultState,
}

impl LocalVault for RestoreLocal<'_> {
    fn read_db<T>(&self, f: impl FnOnce(&Db) -> T) -> Result<T, String> {
        self.vault.with_db_quiet(|db, _, _, _| Ok((f(db), false)))
    }
    fn update_db<T>(&self, f: impl FnOnce(&mut Db) -> (T, bool)) -> Result<T, String> {
        self.vault.with_db(|db, _, _, _| Ok(f(db)))
    }
    fn meta(&self) -> Result<VaultMeta, String> {
        vault::require_meta(self.app)
    }
    fn adopt_meta(&self, _meta: &VaultMeta) -> Result<(), String> {
        Err("Not supported during a restore".into())
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
}

/// Restore points (daily copies and checkpoints of every device), newest first. Device names
/// never fall back to ids; unknown names are read from a copy while the synced vault is unlocked.
#[tauri::command]
pub async fn sync_history_list(app: AppHandle) -> Result<Vec<RestorePoint>, String> {
    let mgr = app.state::<SyncManager>();
    let drive = mgr.connected_drive(&app)?;
    let me = mgr.device_id(&app).unwrap_or_default();
    let my_name = mgr.device_name();
    let keys = app.state::<VaultState>().key_copy().and_then(|(key, vault_id)| {
        let ours = mgr.st().vault_id.as_deref() == Some(seal::vault_id_hex(&vault_id).as_str());
        ours.then(|| seal::SyncKeys::derive(&key, &vault_id))
    });
    let mut known = mgr.st().devices.clone();
    let (rows, learned) = history::list_points(&*drive as &dyn StorageProvider, keys.as_ref(), &mut known, &me, &my_name)
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

/// Restores `point` (an id from `sync_history_list`) into the unlocked vault: verified like a
/// snapshot, safety backup first, then merged (nothing local is removed). The normal sync cycle
/// uploads the result. Errors `VAULT_LOCKED` when locked.
#[tauri::command]
pub async fn sync_history_restore(app: AppHandle, point: String) -> Result<RestoreSummary, String> {
    let mgr = app.state::<SyncManager>();
    let drive = mgr.connected_drive(&app)?;
    let vault_state = app.state::<VaultState>();
    let Some((key, vault_id)) = vault_state.key_copy() else { return Err(engine::ERR_LOCKED.into()) };
    if mgr.st().vault_id.as_deref() != Some(seal::vault_id_hex(&vault_id).as_str()) {
        return Err("Restore points belong to the synced vault, and this device's vault isn't synced. Turn sync on first.".into());
    }
    let device_id = mgr.device_id(&app).ok_or("The sync device id isn't set yet")?;
    let res = {
        let ctx = Ctx::new(&*drive as &dyn StorageProvider, &key, &vault_id, &device_id, &mgr.device_name(), vdb::now_ms());
        let local = RestoreLocal { app: &app, vault: &vault_state };
        history::restore(&ctx, &local, &point).await
    };
    drop(key);
    let summary = res.map_err(|e: SyncError| e.message())?;
    let _ = app.emit(CHANGED_EVENT, serde_json::json!({}));
    notify_status(&app);
    Ok(summary)
}
