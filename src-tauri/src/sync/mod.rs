//! Vault Sync: the [`StorageProvider`] contract and its backends (P2), and the orchestrator (P3):
//! object sealing (`seal`), per-device state and safety backups (`state`), the Tauri-free sync
//! engine (`engine`) and the Tauri commands + scheduler (`commands`).
//! See `design/vault-sync-plan.md`.

pub mod commands;
pub mod engine;
pub mod gdrive;
pub mod markers;
#[cfg(test)]
pub mod memory;
pub mod provider;
pub mod seal;
pub mod state;

#[cfg(test)]
pub(crate) mod contract_tests;
#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod gdrive_mock;

