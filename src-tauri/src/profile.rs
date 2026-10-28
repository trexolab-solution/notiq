//! Dev vs production identity.
//!
//! A debug build (`tauri dev`, `cargo run`) gets its own identifier, so on the same machine it never shares
//! data with an installed Notiq: app-data folder (config, `vault.json`, `vault.nqdb`), the WebView storage,
//! the single-instance lock and the keychain entries are all separate. It also stays away from machine-wide
//! registrations (file associations, the browser-autofill native host, auto-start, self-update) that belong
//! to the installed app. Release builds (`tauri build`) keep the production identity.

pub const IS_DEV: bool = cfg!(debug_assertions);
pub const PROD_IDENTIFIER: &str = "com.trexolab.notiq";
pub const DEV_IDENTIFIER: &str = "com.trexolab.notiq.dev";

/// The app identifier this build runs under (also the app-data folder name).
pub const fn identifier() -> &'static str {
    if IS_DEV { DEV_IDENTIFIER } else { PROD_IDENTIFIER }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_and_prod_never_share_a_folder() {
        assert_ne!(DEV_IDENTIFIER, PROD_IDENTIFIER);
        assert!(DEV_IDENTIFIER.starts_with(PROD_IDENTIFIER)); // still recognisably Notiq
        assert_eq!(identifier(), if cfg!(debug_assertions) { DEV_IDENTIFIER } else { PROD_IDENTIFIER });
    }
}
