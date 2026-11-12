//! Reads a saved vault "SSH / server" entry for the built-in terminal.
//!
//! The terminal only ever receives the entry's path and the chosen sign-in method; the secrets are read here,
//! inside the backend, and handed to the built-in SSH client (`ssh_client.rs`). They are never sent to the web
//! view, written to disk, put on a command line or logged.

use zeroize::Zeroizing;

use crate::vault::VaultState;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Auth { Key, Password }

impl Auth {
    pub fn parse(s: &str) -> Result<Auth, String> {
        match s {
            "key" => Ok(Auth::Key),
            "password" => Ok(Auth::Password),
            _ => Err("Unknown sign-in method".into()),
        }
    }
}

/// What one saved SSH entry says about the server and how to sign in with the chosen method.
pub struct SshSession {
    pub title: String,
    pub host: String,
    pub user: Option<String>,
    pub port: Option<String>,
    pub jump: Option<String>,
    pub auth: Auth,
    pub private_key: Option<Zeroizing<String>>,
    pub passphrase: Option<Zeroizing<String>>,
    pub password: Option<Zeroizing<String>>,
    /// The "Host key fingerprint" saved with the entry; the server must present exactly this key.
    pub fingerprint: Option<String>,
}

fn field(v: &serde_json::Value, k: &str) -> String {
    v.get("fields").and_then(|f| f.get(k)).and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
}

fn secret(v: &serde_json::Value, k: &str) -> Option<Zeroizing<String>> {
    let s = v.get("fields").and_then(|f| f.get(k)).and_then(|x| x.as_str()).unwrap_or("");
    if s.trim().is_empty() { None } else { Some(Zeroizing::new(s.to_string())) }
}

/// Same character rule the entry's "copy command" uses; a leading `-` would be read as an ssh option.
fn safe_token(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.@:-[]%".contains(c))
}

/// Reads and validates the entry (the vault must be unlocked).
pub fn load_session(state: &VaultState, path: &str, auth: Auth) -> Result<SshSession, String> {
    let raw = state.with_db(|db, root, _, _| {
        let rel = crate::vault_db::rel_from_full(root, path)?;
        let e = db.get(&rel).ok_or("This SSH entry no longer exists in the vault")?;
        if e.ext != "ssh" { return Err("That vault entry is not an SSH / server entry".to_string()); }
        Ok((Zeroizing::new(e.content.clone()), false))
    })?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|_| "This SSH entry is damaged")?;

    let host = field(&v, "host");
    if !safe_token(&host) { return Err("This entry has no valid host".into()); }
    let user = Some(field(&v, "username")).filter(|s| !s.is_empty());
    if let Some(u) = &user { if !safe_token(u) { return Err("The user name has characters ssh can't use".into()); } }
    let port = Some(field(&v, "port")).filter(|s| !s.is_empty());
    if let Some(p) = &port {
        if !p.chars().all(|c| c.is_ascii_digit()) || !matches!(p.parse::<u32>(), Ok(1..=65535)) {
            return Err("Port must be a number from 1 to 65535".into());
        }
    }
    let jump = Some(field(&v, "jump")).filter(|s| !s.is_empty());
    if let Some(j) = &jump { if !safe_token(j) { return Err("The jump host has characters ssh can't use".into()); } }

    let private_key = secret(&v, "privateKey");
    let password = secret(&v, "password");
    match auth {
        Auth::Key => match &private_key {
            None => return Err("This entry has no private key saved".into()),
            Some(k) if k.trim_start().starts_with("PuTTY-User-Key-File") =>
                return Err("PuTTY (.ppk) keys can't be used by ssh — convert it to OpenSSH format first".into()),
            _ => {}
        },
        Auth::Password => if password.is_none() { return Err("This entry has no password saved".into()); },
    }
    let title = Some(v.get("title").and_then(|t| t.as_str()).unwrap_or("").trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| match &user { Some(u) => format!("{u}@{host}"), None => host.clone() });
    Ok(SshSession {
        title, host, user, port, jump, auth,
        passphrase: if auth == Auth::Key { secret(&v, "passphrase") } else { None },
        private_key: if auth == Auth::Key { private_key } else { None },
        password: if auth == Auth::Password { password } else { None },
        fingerprint: Some(field(&v, "fingerprint")).filter(|s| !s.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_cannot_smuggle_options() {
        assert!(!safe_token("-oProxyCommand=x"));
        assert!(!safe_token("a b"));
        assert!(!safe_token(""));
        assert!(safe_token("user@host.example"));
        assert!(safe_token("[::1]"));
    }

    #[test]
    fn auth_names_parse() {
        assert_eq!(Auth::parse("key").unwrap(), Auth::Key);
        assert_eq!(Auth::parse("password").unwrap(), Auth::Password);
        assert!(Auth::parse("agent").is_err());
    }
}
