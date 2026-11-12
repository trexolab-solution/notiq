//! Generates an SSH key pair for the "SSH / server" vault entry form.
//!
//! The private key is made here in the backend (OpenSSH format, optionally passphrase-encrypted)
//! and handed straight to the form, which stores it in the vault like an imported one. Nothing is
//! written to disk or logged.

use rand::rngs::OsRng;
use serde::Serialize;
use ssh_key::{private::{KeypairData, RsaKeypair}, Algorithm, HashAlg, LineEnding, PrivateKey};
use zeroize::Zeroizing;

const MAX_PASSPHRASE: usize = 1024;
const MAX_COMMENT: usize = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Ed25519, Rsa(usize) }

impl Kind {
    /// Only the sizes the form offers; anything else is refused.
    pub fn parse(s: &str) -> Result<Kind, String> {
        match s {
            "ed25519" => Ok(Kind::Ed25519),
            "rsa3072" => Ok(Kind::Rsa(3072)),
            "rsa4096" => Ok(Kind::Rsa(4096)),
            _ => Err("Unknown key type".into()),
        }
    }
}

#[derive(Serialize)]
pub struct GeneratedKey {
    /// OpenSSH private key text (ends with a newline).
    pub private_key: String,
    /// One-line public key (`ssh-ed25519 AAAA… comment`), ready for `authorized_keys`.
    pub public_key: String,
    /// `SHA256:…`, the same value `ssh-keygen -l` prints.
    pub fingerprint: String,
}

/// Keeps a comment to one printable line.
fn clean_comment(c: &str) -> String {
    let one: String = c.chars().map(|ch| if ch.is_control() { ' ' } else { ch }).collect();
    one.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_COMMENT).collect()
}

pub fn generate(kind: Kind, passphrase: Option<&str>, comment: &str) -> Result<GeneratedKey, String> {
    let pass = passphrase.filter(|p| !p.is_empty());
    if pass.is_some_and(|p| p.len() > MAX_PASSPHRASE) { return Err("That passphrase is too long".into()); }
    let comment = clean_comment(comment);

    let mut key = match kind {
        Kind::Ed25519 => PrivateKey::random(&mut OsRng, Algorithm::Ed25519).map_err(|e| e.to_string())?,
        Kind::Rsa(bits) => {
            let kp = RsaKeypair::random(&mut OsRng, bits).map_err(|e| e.to_string())?;
            PrivateKey::new(KeypairData::from(kp), "").map_err(|e| e.to_string())?
        }
    };
    key.set_comment(&comment);

    let public = key.public_key().to_openssh().map_err(|e| e.to_string())?;
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    if let Some(p) = pass {
        key = key.encrypt(&mut OsRng, p).map_err(|e| e.to_string())?;
    }
    let private: Zeroizing<String> = key.to_openssh(LineEnding::LF).map_err(|e| e.to_string())?;
    Ok(GeneratedKey { private_key: private.to_string(), public_key: public, fingerprint })
}

/// RSA-4096 takes a few seconds, so it runs off the UI thread.
#[tauri::command]
pub async fn ssh_generate_key(kind: String, passphrase: Option<String>, comment: Option<String>) -> Result<GeneratedKey, String> {
    let kind = Kind::parse(&kind)?;
    let comment = comment.unwrap_or_default();
    if clean_comment(&comment).is_empty() { return Err("Enter a comment for the key".into()); }
    let pass = passphrase.map(Zeroizing::new);
    tauri::async_runtime::spawn_blocking(move || {
        generate(kind, pass.as_ref().map(|p| p.as_str()), &comment)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ed25519_round_trips_and_has_comment() {
        let k = generate(Kind::Ed25519, None, "me@laptop").unwrap();
        assert!(k.private_key.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(k.private_key.ends_with('\n'));
        assert!(k.public_key.starts_with("ssh-ed25519 "));
        assert!(k.public_key.ends_with(" me@laptop"));
        assert!(k.fingerprint.starts_with("SHA256:"));
        let back = PrivateKey::from_openssh(&k.private_key).unwrap();
        assert!(!back.is_encrypted());
        assert_eq!(back.public_key().to_openssh().unwrap(), k.public_key);
    }

    #[test]
    fn passphrase_encrypts_and_unlocks() {
        let k = generate(Kind::Ed25519, Some("s3cret"), "").unwrap();
        let back = PrivateKey::from_openssh(&k.private_key).unwrap();
        assert!(back.is_encrypted());
        assert!(back.decrypt("wrong").is_err());
        let open = back.decrypt("s3cret").unwrap();
        assert_eq!(open.public_key().to_openssh().unwrap(), k.public_key);
    }

    #[test]
    fn rsa_generates_an_ssh_rsa_key() {
        let k = generate(Kind::Rsa(2048), None, "x").unwrap();
        assert!(k.public_key.starts_with("ssh-rsa "));
        PrivateKey::from_openssh(&k.private_key).unwrap();
    }

    #[test]
    fn only_offered_kinds_parse_and_comments_stay_one_line() {
        assert_eq!(Kind::parse("rsa4096"), Ok(Kind::Rsa(4096)));
        assert!(Kind::parse("rsa512").is_err());
        assert_eq!(clean_comment("a\nb\tc  d"), "a b c d");
    }

    /// The real OpenSSH tools accept what we generate: `ssh-keygen -y` derives the same public key.
    #[test]
    fn openssh_reads_our_keys() {
        let dir = std::env::temp_dir().join(format!("notiq-keygen-test-{:x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("k");
        for (pass, name) in [(None, "plain"), (Some("pw 1"), "locked")] {
            let k = generate(Kind::Ed25519, pass, "c").unwrap();
            let path = dir.join(name);
            std::fs::write(&path, &k.private_key).unwrap();
            // ssh-keygen refuses a private key other users can read (Linux and macOS)
            #[cfg(unix)]
            { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap(); }
            let mut cmd = std::process::Command::new("ssh-keygen");
            cmd.arg("-y").arg("-P").arg(pass.unwrap_or("")).arg("-f").arg(&path);
            let Ok(out) = cmd.output() else { let _ = std::fs::remove_dir_all(&dir); return }; // OpenSSH not installed
            assert!(out.status.success(), "ssh-keygen: {}", String::from_utf8_lossy(&out.stderr));
            let theirs = String::from_utf8_lossy(&out.stdout).trim().to_string();
            // ssh-keygen -y omits the comment; compare type + key blob
            let ours: Vec<&str> = k.public_key.split_whitespace().take(2).collect();
            assert_eq!(theirs.split_whitespace().take(2).collect::<Vec<_>>(), ours);
        }
        let _ = f;
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod timing {
    /// `cargo test --lib rsa4096_time -- --ignored --nocapture`: how long the slowest option takes in a dev build.
    #[test]
    #[ignore]
    fn rsa4096_time() {
        let t = std::time::Instant::now();
        let k = super::generate(super::Kind::Rsa(4096), None, "t").unwrap();
        eprintln!("RSA-4096 took {:?}", t.elapsed());
        assert!(k.public_key.starts_with("ssh-rsa "));
    }
}
