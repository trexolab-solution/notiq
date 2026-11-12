//! Opens an SSH session in the built-in terminal from a saved vault "SSH / server" entry.
//!
//! The terminal only ever receives the entry's *path and the chosen sign-in method*; the secrets are
//! read here, inside the backend, so they never travel through the webview. They are used like this:
//!   * private key  -> a short-lived 0600 file passed with `ssh -i`, removed when the session ends;
//!   * password / key passphrase -> typed into the PTY once, when ssh asks for it (never on the
//!     command line, in an environment variable or in a log).

use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use crate::vault::VaultState;

const KEY_PREFIX: &str = "notiq-ssh-";
const KEY_SUFFIX: &str = ".key";

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
    })
}

/// The `ssh` arguments (no secrets). `key_file` is the temporary private key for key sign-in.
pub fn build_args(s: &SshSession, key_file: Option<&Path>) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    if let Some(p) = s.port.as_deref().filter(|p| *p != "22") { a.push("-p".into()); a.push(p.into()); }
    if let Some(j) = &s.jump { a.push("-J".into()); a.push(j.clone()); }
    match (s.auth, key_file) {
        (Auth::Key, Some(f)) => {
            a.push("-i".into()); a.push(f.to_string_lossy().into_owned());
            a.push("-o".into()); a.push("IdentitiesOnly=yes".into());
        }
        _ => {
            // Chosen method is the password: don't let ssh first try whatever keys it finds on disk.
            a.push("-o".into()); a.push("PreferredAuthentications=password,keyboard-interactive".into());
            a.push("-o".into()); a.push("PubkeyAuthentication=no".into());
        }
    }
    a.push("--".into());
    a.push(match &s.user { Some(u) => format!("{u}@{}", s.host), None => s.host.clone() });
    a
}

/// A private key written to disk for the lifetime of one terminal session; deleted on drop.
pub struct KeyFile(PathBuf);

impl KeyFile {
    pub fn path(&self) -> &Path { &self.0 }

    pub fn create(session_id: u32, key: &str) -> Result<KeyFile, String> {
        use std::io::Write;
        let nonce: u64 = rand::random();
        let path = std::env::temp_dir().join(format!("{KEY_PREFIX}{session_id}-{nonce:016x}{KEY_SUFFIX}"));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; opts.mode(0o600); }
        let mut f = opts.open(&path).map_err(|e| format!("Couldn't write the temporary key file: {e}"))?;
        let guard = KeyFile(path); // from here on a failure still removes the file
        // ssh refuses a key without a final newline, and CRLF line ends from a Windows paste.
        let text = Zeroizing::new(format!("{}\n", key.replace("\r\n", "\n").replace('\r', "\n").trim()));
        f.write_all(text.as_bytes()).map_err(|e| format!("Couldn't write the temporary key file: {e}"))?;
        drop(f);
        restrict_to_current_user(&guard.0);
        Ok(guard)
    }
}

impl Drop for KeyFile {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

/// Best effort: ssh itself refuses a key file other users can read, so a failure here only
/// means ssh will say so.
#[cfg(windows)]
fn restrict_to_current_user(path: &Path) {
    use std::os::windows::process::CommandExt;
    if let Ok(user) = std::env::var("USERNAME") {
        let _ = std::process::Command::new("icacls")
            .arg(path).arg("/inheritance:r").arg("/grant:r").arg(format!("{user}:F"))
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output();
    }
}
#[cfg(not(windows))]
fn restrict_to_current_user(_path: &Path) {}

/// Removes key files a crashed earlier run left behind. Call once at app start.
pub fn sweep_stale_keys() {
    let Ok(dir) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for e in dir.flatten() {
        let n = e.file_name();
        let n = n.to_string_lossy();
        if n.starts_with(KEY_PREFIX) && n.ends_with(KEY_SUFFIX) { let _ = std::fs::remove_file(e.path()); }
    }
}

// ── Answering ssh's own prompts ───────────────────────────────────────────────

/// Drops terminal escape sequences so a prompt can be recognised in raw PTY output.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\x1b' { out.push(c); continue; }
        match it.next() {
            Some('[') => { for n in it.by_ref() { if ('@'..='~').contains(&n) { break; } } }
            Some(']') => { for n in it.by_ref() { if n == '\x07' { break; } } }
            _ => {}
        }
    }
    out
}

pub enum Prompt { Password, Passphrase }

/// Types the saved password / passphrase when ssh asks for it — once each, so a later prompt
/// (for example `sudo` on the server) is never answered with it.
pub struct AutoReply {
    password: Option<Zeroizing<String>>,
    passphrase: Option<Zeroizing<String>>,
    tail: String,
}

impl AutoReply {
    pub fn new(s: &SshSession) -> Option<AutoReply> {
        if s.password.is_none() && s.passphrase.is_none() { return None; }
        Some(AutoReply { password: s.password.clone(), passphrase: s.passphrase.clone(), tail: String::new() })
    }

    /// Feed new PTY output; returns bytes to type into the terminal when a prompt just appeared.
    pub fn on_output(&mut self, data: &str) -> Option<Zeroizing<Vec<u8>>> {
        self.tail.push_str(&strip_ansi(data));
        if self.tail.len() > 400 {
            let cut = self.tail.len() - 400;
            let cut = (cut..self.tail.len()).find(|i| self.tail.is_char_boundary(*i)).unwrap_or(0);
            self.tail.drain(..cut);
        }
        let t = self.tail.trim_end().to_ascii_lowercase();
        let secret = match classify(&t)? {
            Prompt::Password => self.password.take(),
            Prompt::Passphrase => self.passphrase.take(),
        }?;
        self.tail.clear();
        let mut bytes = Zeroizing::new(Vec::with_capacity(secret.len() + 1));
        bytes.extend_from_slice(secret.as_bytes());
        bytes.push(b'\r');
        Some(bytes)
    }

    pub fn is_done(&self) -> bool { self.password.is_none() && self.passphrase.is_none() }
}

/// `user@host's password:` / `Password:` or `Enter passphrase for key '…':` at the end of the output.
pub fn classify(lower_trimmed: &str) -> Option<Prompt> {
    if lower_trimmed.ends_with("password:") { return Some(Prompt::Password); }
    let last_line = lower_trimmed.rsplit(['\n', '\r']).next().unwrap_or("");
    if last_line.starts_with("enter passphrase for") && last_line.ends_with(':') { return Some(Prompt::Passphrase); }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(auth: Auth) -> SshSession {
        SshSession {
            title: "t".into(), host: "h.example".into(), user: Some("root".into()), port: Some("2222".into()),
            jump: None, auth, private_key: None, passphrase: Some(Zeroizing::new("pp".into())),
            password: Some(Zeroizing::new("pw".into())),
        }
    }

    #[test]
    fn args_for_key_and_password() {
        let k = build_args(&session(Auth::Key), Some(Path::new("/tmp/k")));
        assert_eq!(k, ["-p", "2222", "-i", "/tmp/k", "-o", "IdentitiesOnly=yes", "--", "root@h.example"]);
        let p = build_args(&session(Auth::Password), None);
        assert!(p.contains(&"PubkeyAuthentication=no".to_string()));
        assert_eq!(p.last().unwrap(), "root@h.example");
        assert!(!p.iter().any(|a| a == "-i"));
    }

    #[test]
    fn tokens_cannot_smuggle_options() {
        assert!(!safe_token("-oProxyCommand=x"));
        assert!(!safe_token("a b"));
        assert!(!safe_token(""));
        assert!(safe_token("user@host.example"));
        assert!(safe_token("[::1]"));
    }

    #[test]
    fn answers_password_prompt_once() {
        let mut a = AutoReply::new(&session(Auth::Password)).unwrap();
        assert!(a.on_output("Welcome\r\nroot@h.example's pass").is_none());
        let sent = a.on_output("word: \x1b[?25h").unwrap();
        assert_eq!(&sent[..], b"pw\r");
        // a later prompt (sudo) must not get it again
        assert!(a.on_output("[sudo] password:").is_none());
    }

    #[test]
    fn answers_passphrase_prompt() {
        let mut s = session(Auth::Key);
        s.password = None;
        let mut a = AutoReply::new(&s).unwrap();
        let sent = a.on_output("Enter passphrase for key 'C:\\x\\k': ").unwrap();
        assert_eq!(&sent[..], b"pp\r");
        assert!(a.is_done());
    }

    #[test]
    fn strips_escape_sequences() {
        assert_eq!(strip_ansi("\x1b[31mhi\x1b[0m\x1b]0;title\x07!"), "hi!");
    }

    #[test]
    fn key_file_is_removed_on_drop_and_gets_final_newline() {
        let kf = KeyFile::create(9_999_999, "-----BEGIN X-----\r\nabc\r\n-----END X-----").unwrap();
        let p = kf.path().to_path_buf();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "-----BEGIN X-----\nabc\n-----END X-----\n");
        drop(kf);
        assert!(!p.exists());
    }

    /// Real `ssh` through a real PTY, with the exact arguments the terminal builds and a real key
    /// file, against a closed local port: proves `ssh` resolves, accepts our arguments and key file,
    /// and that the output reaches the reader. (No server is needed.)
    #[test]
    fn real_ssh_accepts_our_arguments_and_key_file() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        let keydir = std::env::temp_dir().join(format!("notiq-ssh-test-{:x}", rand::random::<u64>()));
        std::fs::create_dir_all(&keydir).unwrap();
        let kp = keydir.join("k");
        let gen = std::process::Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(&kp).output();
        let Ok(g) = gen else { return }; // no OpenSSH installed: nothing to test
        assert!(g.status.success());
        let key = std::fs::read_to_string(&kp).unwrap();

        let mut s = session(Auth::Key);
        s.host = "127.0.0.1".into(); s.port = Some("1".into());
        let kf = KeyFile::create(4_242_424, &key).unwrap();
        let args = build_args(&s, Some(kf.path()));

        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut c = CommandBuilder::new("ssh");
        c.args(args);
        let mut child = pair.slave.spawn_command(c).expect("ssh should resolve and start");
        drop(pair.slave);
        let mut w = pair.master.take_writer().unwrap();
        let mut r = pair.master.try_clone_reader().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut b = [0u8; 1024];
            while let Ok(n) = r.read(&mut b) {
                if n == 0 { break; }
                let _ = tx.send(String::from_utf8_lossy(&b[..n]).into_owned());
            }
        });
        let mut out = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while std::time::Instant::now() < deadline && !out.to_lowercase().contains("connect") {
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(300)) {
                if chunk.contains("[6n") { let _ = w.write_all(b"[1;1R"); } // ConPTY asks for the cursor first
                out.push_str(&chunk);
            }
        }
        let _ = child.kill();
        eprintln!("ssh output: {}", strip_ansi(&out));
        drop(kf);
        let _ = std::fs::remove_dir_all(&keydir);
        let o = strip_ansi(&out).to_lowercase();
        assert!(o.contains("refused") || o.contains("connect to host"), "unexpected ssh output: {o}");
        assert!(!o.contains("unprotected") && !o.contains("bad permissions") && !o.contains("invalid format"), "ssh rejected the key file: {o}");
    }
}
