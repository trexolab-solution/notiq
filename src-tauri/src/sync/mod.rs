//! Vault Sync storage layer (phase P2): the [`StorageProvider`] contract and its
//! backends. Providers move opaque names and bytes only; sealing, merging and
//! scheduling live in the engine (P3, `vault_merge.rs` and the orchestrator).
//! See `design/vault-sync-plan.md`.

// Nothing outside tests uses this layer until the orchestrator (P3) lands.
#![allow(dead_code, unused_imports)]

pub mod gdrive;
pub mod memory;
pub mod provider;

#[cfg(test)]
pub(crate) mod contract_tests;
#[cfg(test)]
mod gdrive_mock;

pub use gdrive::GoogleDriveProvider;
pub use memory::InMemoryProvider;
pub use provider::{AccountInfo, Capabilities, ProviderAuth, ProviderError, RemoteObject, StorageProvider};
