//! The storage provider contract every Vault Sync backend implements.
//!
//! A provider is a dumb, flat object store: opaque names in, opaque bytes out.
//! It never sees entries, keys or plaintext (sealing happens in the engine, P3).
//! See `design/vault-sync-plan.md` → "StorageProvider".

use std::fmt;

use async_trait::async_trait;

/// What a provider can do. A provider without `overwrite` or `delete` can only
/// be used for backups (no live sync).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    /// `put` on an existing name replaces its content.
    pub overwrite: bool,
    /// `delete` is supported.
    pub delete: bool,
    /// Largest object `put` accepts; bigger ones fail with [`ProviderError::TooLarge`].
    pub max_object_bytes: u64,
}

/// Metadata of one stored object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteObject {
    /// The opaque object name (e.g. `devices/<id>.nqs`).
    pub name: String,
    /// Content length in bytes.
    pub size: u64,
    /// Provider revision / etag-like token. It changes whenever the content
    /// changes; compare it only for equality.
    pub revision: String,
    /// Last-modified time (Unix ms), when the provider reports one.
    pub modified_ms: Option<i64>,
}

/// Why a provider call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    /// Not signed in, sign-in expired or access was revoked: the user must reconnect.
    Auth,
    /// No object with that name.
    NotFound,
    /// The service asked us to slow down; try again after `retry_after_s` seconds.
    RateLimited { retry_after_s: u64 },
    /// No network / service unreachable / timed out.
    Offline,
    /// The object exceeds [`Capabilities::max_object_bytes`].
    TooLarge,
    /// Anything else (message is safe to show; never contains tokens).
    Other(String),
}

impl ProviderError {
    /// Whether retrying the same call later can succeed without user action.
    pub fn is_retryable(&self) -> bool {
        matches!(self, ProviderError::RateLimited { .. } | ProviderError::Offline)
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProviderError::Auth => f.write_str("Sign-in expired or access was revoked. Reconnect your storage in Settings."),
            ProviderError::NotFound => f.write_str("The object wasn't found in storage."),
            ProviderError::RateLimited { retry_after_s } => {
                write!(f, "The storage service is busy. Trying again in {retry_after_s} s.")
            }
            ProviderError::Offline => f.write_str("Couldn't reach the storage service. Check your connection."),
            ProviderError::TooLarge => f.write_str("The object is too large for this storage."),
            ProviderError::Other(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for ProviderError {}

/// A flat object store. Names may contain `/` but are not hierarchical paths.
#[async_trait]
pub trait StorageProvider: Send + Sync {
    /// Stable provider id, e.g. `"gdrive"`.
    #[allow(dead_code)] // part of the contract; used once more providers exist
    fn id(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities;
    /// Every object whose name starts with `prefix` (`""` lists everything), sorted by name.
    async fn list(&self, prefix: &str) -> Result<Vec<RemoteObject>, ProviderError>;
    async fn get(&self, name: &str) -> Result<Vec<u8>, ProviderError>;
    /// Create or (if `overwrite`) atomically replace an object. A failed put
    /// leaves either nothing or the previous content — never a torn object.
    async fn put(&self, name: &str, data: &[u8]) -> Result<RemoteObject, ProviderError>;
    async fn delete(&self, name: &str) -> Result<(), ProviderError>;
}

/// The signed-in account, for display ("Connected as …").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountInfo {
    pub label: String,
}

/// Connect / disconnect / account label, kept apart from the data calls.
/// Secrets stay in Rust and the OS keychain; nothing here returns a token.
#[async_trait]
pub trait ProviderAuth: Send + Sync {
    /// Interactive sign-in. Returns the account that was connected.
    async fn connect(&self) -> Result<AccountInfo, ProviderError>;
    /// Revoke access (best effort) and forget all stored credentials.
    async fn disconnect(&self) -> Result<(), ProviderError>;
    /// The connected account, or `None` when not connected.
    #[allow(dead_code)] // the app shows the label stored at connect time instead (no keychain read)
    fn account(&self) -> Option<AccountInfo>;
}

/// Longest accepted object name, in bytes.
pub const MAX_NAME_LEN: usize = 512;

/// Object names are ASCII `[A-Za-z0-9._-]` segments joined by `/`: no empty,
/// `.` or `..` segments, no leading/trailing `/`. Keeping names this boring
/// makes them safe for every backend (Drive query strings, file systems, URLs).
pub fn validate_name(name: &str) -> Result<(), ProviderError> {
    let bad = |why: &str| Err(ProviderError::Other(format!("Invalid object name ({why})")));
    if name.is_empty() {
        return bad("empty");
    }
    if name.len() > MAX_NAME_LEN {
        return bad("too long");
    }
    for seg in name.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return bad("empty or relative segment");
        }
        if !seg.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
            return bad("unsupported character");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_validated() {
        for ok in ["vault.meta", "devices/abc-123.nqs", "blobs/9f86d081", "a/b/c_d.e"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        let long = "a".repeat(MAX_NAME_LEN + 1);
        for bad in ["", "/a", "a/", "a//b", "../a", "a/./b", "a b", "a'b", "a\\b", "ü", long.as_str()] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn retryable_errors() {
        assert!(ProviderError::Offline.is_retryable());
        assert!(ProviderError::RateLimited { retry_after_s: 3 }.is_retryable());
        for e in [ProviderError::Auth, ProviderError::NotFound, ProviderError::TooLarge, ProviderError::Other("x".into())] {
            assert!(!e.is_retryable());
        }
        assert!(ProviderError::RateLimited { retry_after_s: 7 }.to_string().contains("7 s"));
    }
}
