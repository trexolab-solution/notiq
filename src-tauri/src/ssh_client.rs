//! Built-in SSH client for the terminal (no `ssh` program needed on the machine).
//!
//! The session talks SSH itself (the `russh` library): host-key check, sign-in with a private key or a
//! password, an interactive shell with a pseudo-terminal, window resizes, and an optional jump host.
//! Everything the user has to answer (a new host's fingerprint, a key passphrase, a one-time code) is asked
//! in the terminal itself, like OpenSSH does, so the secrets saved in the vault stay in memory and never
//! touch the disk or the web view.
//!
//! The session core ([`run`]) only needs a [`Sink`] for output and a channel of [`Cmd`] for input, so it is
//! tested against an in-process SSH server; [`start`] hands it the terminal's events.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;


use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect, MethodKind};
use tokio::sync::{mpsc, Mutex};
use zeroize::Zeroizing;

use crate::ssh_connect::{Auth, SshSession};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const KEEPALIVE: Duration = Duration::from_secs(30);
const PASSPHRASE_TRIES: usize = 3;

// ── what the session is told ─────────────────────────────────────────────────

/// Input for a running session.
pub enum Cmd {
    /// Keystrokes from the terminal.
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    /// End the session.
    Close,
}

/// Where the session's output goes (the terminal).
pub trait Sink: Send + Sync {
    fn out(&self, data: &[u8]);
}

fn say(sink: &dyn Sink, text: &str) {
    sink.out(text.as_bytes());
}

/// Red text, for problems the user has to read.
fn say_err(sink: &dyn Sink, text: &str) {
    say(sink, &format!("\r\n\x1b[31m{text}\x1b[0m\r\n"));
}

// ── connection details ───────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Jump {
    pub user: String,
    pub host: String,
    pub port: u16,
}

pub struct Connect {
    pub title: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub jump: Option<Jump>,
    /// The fingerprint saved with the entry ("Host key fingerprint"), when there is one.
    pub pinned_fp: Option<String>,
    pub auth: Auth,
    pub key: Option<Zeroizing<String>>,
    pub passphrase: Option<Zeroizing<String>>,
    pub password: Option<Zeroizing<String>>,
}

/// `[user@]host[:port]`, with `[::1]:22` for IPv6. The user and port default to the target's.
pub fn parse_jump(spec: &str, default_user: &str, default_port: u16) -> Result<Jump, String> {
    let (user, rest) = match spec.split_once('@') {
        Some((u, r)) if !u.is_empty() => (u.to_string(), r),
        Some((_, r)) => (default_user.to_string(), r),
        None => (default_user.to_string(), spec),
    };
    let (host, port) = if let Some(inner) = rest.strip_prefix('[') {
        let (h, after) = inner.split_once(']').ok_or("The jump host has an unclosed [")?;
        let port = match after.strip_prefix(':') {
            Some(p) => p.parse::<u16>().map_err(|_| "The jump host's port isn't a number")?,
            None if after.is_empty() => default_port,
            None => return Err("The jump host isn't written as host or host:port".into()),
        };
        (h.to_string(), port)
    } else if rest.matches(':').count() == 1 {
        let (h, p) = rest.split_once(':').unwrap_or((rest, ""));
        (h.to_string(), p.parse::<u16>().map_err(|_| "The jump host's port isn't a number")?)
    } else {
        (rest.to_string(), default_port) // a bare host, or an IPv6 address without a port
    };
    if host.is_empty() || user.is_empty() { return Err("The jump host needs a host name".into()); }
    Ok(Jump { user, host, port })
}

impl Connect {
    pub fn from_session(s: SshSession) -> Result<Connect, String> {
        let port = match s.port.as_deref() {
            Some(p) => p.parse::<u16>().map_err(|_| "The port isn't a number".to_string())?,
            None => 22,
        };
        let user = s.user.clone().ok_or("This entry has no user name")?;
        let jump = match s.jump.as_deref() {
            Some(j) => Some(parse_jump(j, &user, 22)?),
            None => None,
        };
        Ok(Connect {
            title: s.title, host: s.host, port, user, jump, pinned_fp: s.fingerprint, auth: s.auth,
            key: s.private_key, passphrase: s.passphrase, password: s.password,
        })
    }
}

// ── trusted hosts ────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct HostEntry { alg: String, fp: String }

pub enum Known {
    Match,
    Unknown,
    /// Another key is on record for this host (its fingerprint).
    Changed(String),
}

/// Fingerprints of the hosts the user has accepted, kept in the app's data folder.
#[derive(Clone)]
pub struct KnownHosts { path: PathBuf }

impl KnownHosts {
    pub fn new(path: PathBuf) -> Self { KnownHosts { path } }

    pub fn path(&self) -> &std::path::Path { &self.path }

    fn id(host: &str, port: u16) -> String { format!("{}:{port}", host.trim_matches(['[', ']']).to_lowercase()) }

    fn load(&self) -> HashMap<String, HostEntry> {
        std::fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn check(&self, host: &str, port: u16, fp: &str) -> Known {
        match self.load().get(&Self::id(host, port)) {
            None => Known::Unknown,
            Some(e) if e.fp == fp => Known::Match,
            Some(e) => Known::Changed(e.fp.clone()),
        }
    }

    pub fn remember(&self, host: &str, port: u16, alg: &str, fp: &str) -> std::io::Result<()> {
        let mut all = self.load();
        all.insert(Self::id(host, port), HostEntry { alg: alg.to_string(), fp: fp.to_string() });
        let tmp = self.path.with_extension("tmp");
        if let Some(dir) = self.path.parent() { std::fs::create_dir_all(dir)?; }
        std::fs::write(&tmp, serde_json::to_vec_pretty(&all).unwrap_or_default())?;
        std::fs::rename(&tmp, &self.path)
    }
}

// ── asking the user in the terminal ──────────────────────────────────────────

struct Prompter {
    rx: mpsc::UnboundedReceiver<Cmd>,
    sink: Arc<dyn Sink>,
    cols: u16,
    rows: u16,
    closed: bool,
}

impl Prompter {
    /// Keys typed while nothing asked for them are dropped (a stray Enter must not answer the next question).
    fn drain(&mut self) {
        while let Ok(c) = self.rx.try_recv() {
            match c {
                Cmd::Resize { cols, rows } => { self.cols = cols; self.rows = rows; }
                Cmd::Close => self.closed = true,
                Cmd::Data(_) => {}
            }
        }
    }

    /// One line typed in the terminal. `None` if the user pressed Ctrl+C or the terminal closed.
    async fn line(&mut self, echo: bool) -> Option<String> {
        self.drain();
        let mut buf: Vec<u8> = Vec::new();
        loop {
            if self.closed { return None; }
            match self.rx.recv().await? {
                Cmd::Close => { self.closed = true; return None; }
                Cmd::Resize { cols, rows } => { self.cols = cols; self.rows = rows; }
                Cmd::Data(d) => {
                    for b in d {
                        match b {
                            b'\r' | b'\n' => {
                                say(&*self.sink, "\r\n");
                                return Some(String::from_utf8_lossy(&buf).into_owned());
                            }
                            3 => { say(&*self.sink, "^C\r\n"); return None; }
                            0x7f | 0x08 => {
                                // drop one whole character, not one byte of it
                                while let Some(last) = buf.pop() { if last & 0xC0 != 0x80 { break; } }
                                if echo { say(&*self.sink, "\x08 \x08"); }
                            }
                            0x1b => {} // escape sequences (arrows…) are not text
                            c if c < 0x20 => {}
                            c => { buf.push(c); if echo { self.sink.out(&[c]); } }
                        }
                    }
                }
            }
        }
    }
}

// ── the host-key check ───────────────────────────────────────────────────────

struct Hk {
    host: String,
    port: u16,
    pinned: Option<String>,
    known: KnownHosts,
    prompter: Arc<Mutex<Prompter>>,
    sink: Arc<dyn Sink>,
}

/// `SHA256:abc` for either `SHA256:abc` or `abc` (the entry's fingerprint is typed by hand).
fn norm_fp(fp: &str) -> String {
    let t = fp.trim();
    if t.to_ascii_uppercase().starts_with("SHA256:") { format!("SHA256:{}", &t[7..]) } else { format!("SHA256:{t}") }
}

impl client::Handler for Hk {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            say_err(&*self.sink, "This server uses a certificate host key, which Notiq can't check yet.");
            return Ok(false);
        };
        let alg = key.algorithm().to_string();
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        let sink = self.sink.clone();

        if let Some(p) = &self.pinned {
            if norm_fp(p) != fp {
                say_err(&*sink, &format!(
                    "HOST KEY DOES NOT MATCH the fingerprint saved with this server.\r\nSaved:  {}\r\nServer: {fp}\r\nConnection refused.", norm_fp(p)));
                return Ok(false);
            }
            let _ = self.known.remember(&self.host, self.port, &alg, &fp);
            return Ok(true);
        }
        match self.known.check(&self.host, self.port, &fp) {
            Known::Match => Ok(true),
            Known::Changed(old) => {
                say_err(&*sink, &format!(
                    "WARNING: THE HOST KEY FOR {}:{} HAS CHANGED.\r\nSomeone may be intercepting this connection, or the server was reinstalled.\r\nKnown:  {old}\r\nServer: {fp}\r\nConnection refused. If you trust the change, delete the line for this host in {}",
                    self.host, self.port, self.known.path().display()));
                Ok(false)
            }
            Known::Unknown => {
                say(&*sink, &format!(
                    "The authenticity of host '{}' (port {}) can't be established.\r\n{alg} key fingerprint is {fp}.\r\nAre you sure you want to continue connecting (yes/no)? ",
                    self.host, self.port));
                let answer = self.prompter.lock().await.line(true).await;
                if matches!(answer.as_deref().map(|a| a.trim().to_ascii_lowercase()).as_deref(), Some("yes") | Some("y")) {
                    let _ = self.known.remember(&self.host, self.port, &alg, &fp);
                    say(&*sink, "Host added to Notiq's trusted hosts.\r\n");
                    Ok(true)
                } else {
                    say(&*sink, "Host key not accepted. Connection closed.\r\n");
                    Ok(false)
                }
            }
        }
    }
}

// ── connecting and signing in ────────────────────────────────────────────────

type Conn = client::Handle<Hk>;

fn config() -> Arc<client::Config> {
    Arc::new(client::Config { keepalive_interval: Some(KEEPALIVE), keepalive_max: 3, ..Default::default() })
}

fn hk(host: &str, port: u16, pinned: Option<String>, known: &KnownHosts, p: &Arc<Mutex<Prompter>>, sink: &Arc<dyn Sink>) -> Hk {
    Hk { host: host.to_string(), port, pinned, known: known.clone(), prompter: p.clone(), sink: sink.clone() }
}

fn conn_err(host: &str, e: russh::Error) -> String {
    match e {
        russh::Error::UnknownKey => format!("{host}: the host key was not accepted."),
        other => format!("Couldn't connect to {host}: {other}"),
    }
}

async fn open_direct(host: &str, port: u16, handler: Hk) -> Result<Conn, String> {
    let target = host.trim_matches(['[', ']']).to_string();
    match tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config(), (target.as_str(), port), handler)).await {
        Err(_) => Err(format!("Timed out connecting to {host}:{port}.")),
        Ok(Err(e)) => Err(conn_err(host, e)),
        Ok(Ok(h)) => Ok(h),
    }
}

/// The private key, asking for its passphrase in the terminal when it is encrypted and none is saved (or it is wrong).
async fn load_key(c: &Connect, prompter: &Arc<Mutex<Prompter>>, sink: &Arc<dyn Sink>) -> Result<russh::keys::PrivateKey, String> {
    let text = c.key.as_ref().ok_or("This entry has no private key saved")?;
    let saved = c.passphrase.as_ref().map(|p| p.as_str());
    match decode_secret_key(text, saved) {
        Ok(k) => return Ok(k),
        Err(e) => {
            let encrypted = matches!(decode_secret_key(text, None), Err(russh::keys::Error::KeyIsEncrypted));
            if !encrypted { return Err(format!("That private key can't be read: {e}")); }
        }
    }
    if saved.is_some() { say(&**sink, "The saved passphrase didn't unlock this key.\r\n"); }
    for _ in 0..PASSPHRASE_TRIES {
        say(&**sink, &format!("Enter passphrase for key '{}': ", c.title));
        let Some(p) = prompter.lock().await.line(false).await else { return Err("Cancelled.".into()) };
        if let Ok(k) = decode_secret_key(text, Some(p.as_str())) { return Ok(k); }
        say(&**sink, "Wrong passphrase, try again.\r\n");
    }
    Err("Too many wrong passphrases.".into())
}

async fn keyboard_interactive(h: &mut Conn, user: &str, c: &Connect, prompter: &Arc<Mutex<Prompter>>, sink: &Arc<dyn Sink>) -> Result<(), String> {
    let denied = || format!("Permission denied (password) for {user}.");
    let mut resp = h.authenticate_keyboard_interactive_start(user, None::<String>).await.map_err(|e| e.to_string())?;
    let mut used_saved = false;
    for _ in 0..6 {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Err(denied()),
            KeyboardInteractiveAuthResponse::InfoRequest { instructions, prompts, .. } => {
                if !instructions.trim().is_empty() { say(&**sink, &format!("{}\r\n", instructions.trim().replace('\n', "\r\n"))); }
                let mut answers = Vec::new();
                for p in prompts {
                    let wants_password = p.prompt.to_ascii_lowercase().contains("password");
                    if wants_password && !used_saved && c.password.is_some() {
                        used_saved = true;
                        answers.push(c.password.as_ref().map(|p| p.to_string()).unwrap_or_default());
                    } else {
                        say(&**sink, &p.prompt);
                        let Some(a) = prompter.lock().await.line(p.echo).await else { return Err("Cancelled.".into()) };
                        answers.push(a);
                    }
                }
                resp = h.authenticate_keyboard_interactive_respond(answers).await.map_err(|e| e.to_string())?;
            }
        }
    }
    Err(denied())
}

async fn authenticate(h: &mut Conn, user: &str, c: &Connect, prompter: &Arc<Mutex<Prompter>>, sink: &Arc<dyn Sink>) -> Result<(), String> {
    match c.auth {
        Auth::Key => {
            let key = load_key(c, prompter, sink).await?;
            let hash = h.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
            let r = h.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(|e| e.to_string())?;
            if r.success() { Ok(()) } else { Err(format!("Permission denied (publickey): the server didn't accept this key for {user}. Is its public key in ~/.ssh/authorized_keys?")) }
        }
        Auth::Password => {
            let pw = c.password.as_ref().ok_or("This entry has no password saved")?;
            match h.authenticate_password(user, pw.as_str()).await.map_err(|e| e.to_string())? {
                russh::client::AuthResult::Success => Ok(()),
                russh::client::AuthResult::Failure { remaining_methods, .. } => {
                    if remaining_methods.contains(&MethodKind::KeyboardInteractive) {
                        keyboard_interactive(h, user, c, prompter, sink).await
                    } else {
                        Err(format!("Permission denied (password) for {user}."))
                    }
                }
            }
        }
    }
}

// ── the session ──────────────────────────────────────────────────────────────

/// Connects, signs in and runs an interactive shell until it ends. Problems come back as text for the terminal.
pub async fn run(c: Connect, known: KnownHosts, sink: Arc<dyn Sink>, rx: mpsc::UnboundedReceiver<Cmd>, cols: u16, rows: u16) -> Result<(), String> {
    let prompter = Arc::new(Mutex::new(Prompter { rx, sink: sink.clone(), cols, rows, closed: false }));

    // Optional jump host: connect and sign in there first, then reach the target through it.
    let mut _jump: Option<Conn> = None;
    let mut h: Conn = if let Some(j) = &c.jump {
        say(&*sink, &format!("Connecting to jump host {}@{}:{} …\r\n", j.user, j.host, j.port));
        let mut jh = open_direct(&j.host, j.port, hk(&j.host, j.port, None, &known, &prompter, &sink)).await?;
        authenticate(&mut jh, &j.user, &c, &prompter, &sink).await?;
        say(&*sink, &format!("Connecting to {}:{} through it …\r\n", c.host, c.port));
        let ch = jh.channel_open_direct_tcpip(c.host.trim_matches(['[', ']']).to_string(), c.port as u32, "127.0.0.1", 0).await
            .map_err(|e| format!("The jump host couldn't reach {}:{} ({e}).", c.host, c.port))?;
        let handler = hk(&c.host, c.port, c.pinned_fp.clone(), &known, &prompter, &sink);
        let conn = match tokio::time::timeout(CONNECT_TIMEOUT, client::connect_stream(config(), ch.into_stream(), handler)).await {
            Err(_) => return Err(format!("Timed out connecting to {}:{}.", c.host, c.port)),
            Ok(Err(e)) => return Err(conn_err(&c.host, e)),
            Ok(Ok(h)) => h,
        };
        _jump = Some(jh);
        conn
    } else {
        say(&*sink, &format!("Connecting to {}:{} …\r\n", c.host, c.port));
        open_direct(&c.host, c.port, hk(&c.host, c.port, c.pinned_fp.clone(), &known, &prompter, &sink)).await?
    };

    authenticate(&mut h, &c.user, &c, &prompter, &sink).await?;

    let mut ch = h.channel_open_session().await.map_err(|e| format!("Couldn't open a session: {e}"))?;
    let (cols, rows) = { let p = prompter.lock().await; (p.cols, p.rows) };
    ch.request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[]).await.map_err(|e| format!("Couldn't get a terminal: {e}"))?;
    ch.request_shell(false).await.map_err(|e| format!("Couldn't start a shell: {e}"))?;

    let mut p = prompter.lock().await;
    let mut exit: Option<u32> = None;
    loop {
        tokio::select! {
            cmd = p.rx.recv() => match cmd {
                Some(Cmd::Data(d)) => { if ch.data(&d[..]).await.is_err() { break; } }
                Some(Cmd::Resize { cols, rows }) => { let _ = ch.window_change(cols as u32, rows as u32, 0, 0).await; }
                Some(Cmd::Close) | None => break,
            },
            msg = ch.wait() => match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => sink.out(&data),
                Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
                Some(ChannelMsg::Eof) => {}
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            },
        }
    }
    drop(p);
    let _ = h.disconnect(Disconnect::ByApplication, "", "en").await;
    match exit {
        Some(0) | None => say(&*sink, &format!("\r\nConnection to {} closed.\r\n", c.host)),
        Some(n) => say(&*sink, &format!("\r\nConnection to {} closed (exit status {n}).\r\n", c.host)),
    }
    Ok(())
}

// ── the terminal's side ──────────────────────────────────────────────────────

/// UTF-8 text from raw bytes: a read can end inside a multi-byte character, so those bytes wait for the rest.
pub fn take_utf8(pending: &mut Vec<u8>) -> String {
    let keep_from = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => pending.len(),
    };
    let rest = pending.split_off(keep_from);
    let text = String::from_utf8_lossy(pending).into_owned();
    *pending = rest;
    text
}

/// What a terminal holds for one session; dropping it ends the session.
pub struct SshHandle { tx: mpsc::UnboundedSender<Cmd> }

impl SshHandle {
    pub fn write(&self, data: Vec<u8>) { let _ = self.tx.send(Cmd::Data(data)); }
    pub fn resize(&self, cols: u16, rows: u16) { let _ = self.tx.send(Cmd::Resize { cols, rows }); }
}

impl Drop for SshHandle {
    fn drop(&mut self) { let _ = self.tx.send(Cmd::Close); }
}

#[cfg(desktop)]
struct TauriSink { app: tauri::AppHandle, id: u32, pending: std::sync::Mutex<Vec<u8>> }

#[cfg(desktop)]
impl Sink for TauriSink {
    fn out(&self, data: &[u8]) {
        use tauri::Emitter;
        let text = {
            let mut p = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            p.extend_from_slice(data);
            take_utf8(&mut p)
        };
        if !text.is_empty() {
            #[derive(serde::Serialize, Clone)]
            struct Data { id: u32, data: String }
            let _ = self.app.emit("terminal-data", Data { id: self.id, data: text });
        }
    }
}

/// Starts a session for terminal `id`. `finished` runs when it ends (to forget the session) before the terminal is told.
#[cfg(desktop)]
pub fn start(app: tauri::AppHandle, id: u32, connect: Connect, known_path: PathBuf, cols: u16, rows: u16,
             finished: Box<dyn FnOnce() + Send + 'static>) -> SshHandle {
    use tauri::Emitter;
    let (tx, rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn Sink> = Arc::new(TauriSink { app: app.clone(), id, pending: std::sync::Mutex::new(Vec::new()) });
    tauri::async_runtime::spawn(async move {
        if let Err(msg) = run(connect, KnownHosts::new(known_path), sink.clone(), rx, cols, rows).await {
            say_err(&*sink, &msg);
        }
        finished();
        #[derive(serde::Serialize, Clone)]
        struct Exit { id: u32 }
        let _ = app.emit("terminal-exit", Exit { id });
    });
    SshHandle { tx }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jump_host_forms() {
        let j = |s| parse_jump(s, "me", 22).unwrap();
        assert_eq!(j("bastion.example.com"), Jump { user: "me".into(), host: "bastion.example.com".into(), port: 22 });
        assert_eq!(j("ops@bastion:2200"), Jump { user: "ops".into(), host: "bastion".into(), port: 2200 });
        assert_eq!(j("[::1]:2222"), Jump { user: "me".into(), host: "::1".into(), port: 2222 });
        assert_eq!(j("u@[fe80::1]"), Jump { user: "u".into(), host: "fe80::1".into(), port: 22 });
        assert_eq!(j("fe80::1").host, "fe80::1");
        assert!(parse_jump("host:abc", "me", 22).is_err());
        assert!(parse_jump("[::1", "me", 22).is_err());
    }

    #[test]
    fn fingerprints_are_compared_in_one_form() {
        assert_eq!(norm_fp("SHA256:abc"), "SHA256:abc");
        assert_eq!(norm_fp(" abc "), "SHA256:abc");
        assert_eq!(norm_fp("sha256:abc"), "SHA256:abc");
    }

    #[test]
    fn known_hosts_remember_match_and_change() {
        let dir = std::env::temp_dir().join(format!("notiq-kh-{:x}", rand::random::<u64>()));
        let kh = KnownHosts::new(dir.join("hosts.json"));
        assert!(matches!(kh.check("Example.COM", 22, "SHA256:a"), Known::Unknown));
        kh.remember("example.com", 22, "ssh-ed25519", "SHA256:a").unwrap();
        assert!(matches!(kh.check("EXAMPLE.com", 22, "SHA256:a"), Known::Match));
        assert!(matches!(kh.check("example.com", 22, "SHA256:b"), Known::Changed(old) if old == "SHA256:a"));
        assert!(matches!(kh.check("example.com", 2222, "SHA256:a"), Known::Unknown));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn utf8_split_across_reads_is_held_back() {
        let euro = "€".as_bytes(); // 3 bytes
        let mut p = euro[..2].to_vec();
        assert_eq!(take_utf8(&mut p), "");
        p.extend_from_slice(&euro[2..]);
        assert_eq!(take_utf8(&mut p), "€");
        assert!(p.is_empty());
    }

    // ── an in-process SSH server to talk to ────────────────────────────────

    use std::sync::Mutex as StdMutex;
    use russh::server::{self, Msg, Server as _, Session, VerifiedPublicKey};
    use russh::{Channel, ChannelId};
    use tokio::net::TcpListener;

    #[derive(Clone, Default)]
    struct Seen { sizes: Arc<StdMutex<Vec<(u32, u32)>>>, user: Arc<StdMutex<String>> }

    #[derive(Clone)]
    struct TestServer { password: String, pubkey: Option<String>, seen: Seen, shell: Option<ChannelId> }

    impl server::Server for TestServer {
        type Handler = Self;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self { self.clone() }
    }

    impl server::Handler for TestServer {
        type Error = russh::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<server::Auth, Self::Error> {
            *self.seen.user.lock().unwrap() = user.to_string();
            Ok(if user == "alice" && password == self.password { server::Auth::Accept } else { server::Auth::reject() })
        }

        async fn auth_publickey(&mut self, user: &str, key: VerifiedPublicKey<'_>) -> Result<server::Auth, Self::Error> {
            *self.seen.user.lock().unwrap() = user.to_string();
            let offered = key.public_key.to_openssh().unwrap_or_default();
            let same = |a: &str, b: &str| a.split_whitespace().take(2).eq(b.split_whitespace().take(2));
            Ok(match &self.pubkey {
                Some(p) if user == "alice" && same(&offered, p) => server::Auth::Accept,
                _ => server::Auth::reject(),
            })
        }

        async fn channel_open_session(&mut self, _c: Channel<Msg>, reply: server::ChannelOpenHandle, _s: &mut Session) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn channel_open_direct_tcpip(&mut self, channel: Channel<Msg>, host: &str, port: u32, _oa: &str, _op: u32,
                                           reply: server::ChannelOpenHandle, _s: &mut Session) -> Result<(), Self::Error> {
            let target = tokio::net::TcpStream::connect((host, port as u16)).await.map_err(|_| russh::Error::Disconnect)?;
            reply.accept().await;
            tokio::spawn(async move {
                let mut a = channel.into_stream();
                let mut b = target;
                let _ = tokio::io::copy_bidirectional(&mut a, &mut b).await;
            });
            Ok(())
        }

        async fn pty_request(&mut self, channel: ChannelId, _t: &str, cols: u32, rows: u32, _pw: u32, _ph: u32,
                             _m: &[(russh::Pty, u32)], session: &mut Session) -> Result<(), Self::Error> {
            self.seen.sizes.lock().unwrap().push((cols, rows));
            let _ = session.channel_success(channel);
            Ok(())
        }

        async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
            self.shell = Some(channel);
            let _ = session.channel_success(channel);
            let _ = session.data(channel, b"welcome\r\n$ ".to_vec());
            Ok(())
        }

        async fn window_change_request(&mut self, _c: ChannelId, cols: u32, rows: u32, _pw: u32, _ph: u32, _s: &mut Session) -> Result<(), Self::Error> {
            self.seen.sizes.lock().unwrap().push((cols, rows));
            Ok(())
        }

        async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
            // Only the shell talks back; a forwarded connection's bytes belong to whoever is on the other end of it.
            if self.shell != Some(channel) { return Ok(()); }
            let text = String::from_utf8_lossy(data).into_owned();
            if text.contains("exit") {
                let _ = session.exit_status_request(channel, 0);
                let _ = session.eof(channel);
                let _ = session.close(channel);
            } else {
                let _ = session.data(channel, format!("got:{}\r\n", text.trim()).into_bytes());
            }
            Ok(())
        }
    }

    struct Fixture { port: u16, seen: Seen, host_fp: String }

    /// Starts a server on a free local port; `password` / `pubkey` say who may sign in.
    async fn start_server(password: &str, pubkey: Option<String>) -> Fixture {
        let pem = crate::ssh_keygen::generate(crate::ssh_keygen::Kind::Ed25519, None, "").unwrap().private_key;
        let host_key = russh::keys::PrivateKey::from_openssh(&pem).unwrap();
        let host_fp = host_key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let cfg = Arc::new(server::Config {
            keys: vec![host_key],
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            ..Default::default()
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Seen::default();
        let mut srv = TestServer { password: password.into(), pubkey, seen: seen.clone(), shell: None };
        tokio::spawn(async move { let _ = srv.run_on_socket(cfg, &listener).await; });
        Fixture { port, seen, host_fp }
    }

    #[derive(Default)]
    struct Collect(StdMutex<Vec<u8>>);
    impl Sink for Collect { fn out(&self, d: &[u8]) { self.0.lock().unwrap().extend_from_slice(d); } }
    impl Collect {
        fn text(&self) -> String { String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned() }
        /// Waits until the terminal text contains `needle` after the first `from` bytes.
        async fn wait_for(&self, needle: &str) {
            for _ in 0..250 {
                if self.text().contains(needle) { return; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            panic!("never saw {needle:?}; terminal showed:\n{}", self.text());
        }
    }

    fn type_line(tx: &mpsc::UnboundedSender<Cmd>, s: &str) { tx.send(Cmd::Data(format!("{s}\r").into_bytes())).unwrap(); }

    fn password_connect(port: u16, pw: &str) -> Connect {
        Connect { title: "t".into(), host: "127.0.0.1".into(), port, user: "alice".into(), jump: None, pinned_fp: None, auth: Auth::Password,
                  key: None, passphrase: None, password: Some(Zeroizing::new(pw.into())) }
    }

    fn key_connect(port: u16, private: &str, passphrase: Option<&str>) -> Connect {
        Connect { title: "t".into(), host: "127.0.0.1".into(), port, user: "alice".into(), jump: None, pinned_fp: None, auth: Auth::Key,
                  key: Some(Zeroizing::new(private.into())), passphrase: passphrase.map(|p| Zeroizing::new(p.into())), password: None }
    }

    fn temp_known() -> (KnownHosts, PathBuf) {
        let dir = std::env::temp_dir().join(format!("notiq-ssh-test-{:x}", rand::random::<u64>()));
        (KnownHosts::new(dir.join("hosts.json")), dir)
    }

    type Running = tokio::task::JoinHandle<Result<(), String>>;
    fn spawn_run(c: Connect, known: KnownHosts) -> (Arc<Collect>, mpsc::UnboundedSender<Cmd>, Running) {
        let sink = Arc::new(Collect::default());
        let (tx, rx) = mpsc::unbounded_channel();
        let h = tokio::spawn(run(c, known, sink.clone(), rx, 100, 30));
        (sink, tx, h)
    }

    async fn finish(h: Running) -> Result<(), String> {
        tokio::time::timeout(Duration::from_secs(10), h).await.expect("session didn't end").unwrap()
    }

    #[tokio::test]
    async fn password_login_asks_about_a_new_host_then_runs_a_shell() {
        let fx = start_server("pw1", None).await;
        let (known, dir) = temp_known();
        let (sink, tx, h) = spawn_run(password_connect(fx.port, "pw1"), known.clone());

        sink.wait_for("(yes/no)").await;
        assert!(sink.text().contains(&fx.host_fp), "the fingerprint is shown");
        type_line(&tx, "yes");
        sink.wait_for("welcome").await;
        assert_eq!(*fx.seen.sizes.lock().unwrap(), vec![(100, 30)], "the terminal size is asked for up front");

        tx.send(Cmd::Resize { cols: 120, rows: 40 }).unwrap();
        for _ in 0..100 { if fx.seen.sizes.lock().unwrap().len() == 2 { break; } tokio::time::sleep(Duration::from_millis(20)).await; }
        assert_eq!(fx.seen.sizes.lock().unwrap().last(), Some(&(120, 40)));

        type_line(&tx, "hello");
        sink.wait_for("got:hello").await;
        type_line(&tx, "exit");
        finish(h).await.unwrap();
        assert!(sink.text().contains("closed"));

        // The host is remembered: the second connection doesn't ask.
        let (sink2, tx2, h2) = spawn_run(password_connect(fx.port, "pw1"), known);
        sink2.wait_for("welcome").await;
        assert!(!sink2.text().contains("(yes/no)"));
        type_line(&tx2, "exit");
        finish(h2).await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn declining_the_host_key_stops_before_any_password_is_sent() {
        let fx = start_server("pw1", None).await;
        let (known, dir) = temp_known();
        let (sink, tx, h) = spawn_run(password_connect(fx.port, "pw1"), known);
        sink.wait_for("(yes/no)").await;
        type_line(&tx, "no");
        assert!(finish(h).await.is_err());
        assert_eq!(*fx.seen.user.lock().unwrap(), "", "the server never saw a sign-in attempt");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_wrong_password_is_refused() {
        let fx = start_server("pw1", None).await;
        let (known, dir) = temp_known();
        known.remember("127.0.0.1", fx.port, "ssh-ed25519", &fx.host_fp).unwrap();
        let (_sink, _tx, h) = spawn_run(password_connect(fx.port, "nope"), known);
        let err = finish(h).await.unwrap_err();
        assert!(err.contains("Permission denied"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_changed_host_key_is_refused() {
        let fx = start_server("pw1", None).await;
        let (known, dir) = temp_known();
        known.remember("127.0.0.1", fx.port, "ssh-ed25519", "SHA256:someoneelse").unwrap();
        let (sink, _tx, h) = spawn_run(password_connect(fx.port, "pw1"), known);
        assert!(finish(h).await.is_err());
        assert!(sink.text().contains("HAS CHANGED"), "{}", sink.text());
        assert_eq!(*fx.seen.user.lock().unwrap(), "");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_saved_fingerprint_is_checked_and_skips_the_question() {
        let fx = start_server("pw1", None).await;
        let (known, dir) = temp_known();
        let mut ok = password_connect(fx.port, "pw1");
        ok.pinned_fp = Some(fx.host_fp.trim_start_matches("SHA256:").to_string()); // typed without the prefix
        let (sink, tx, h) = spawn_run(ok, known.clone());
        sink.wait_for("welcome").await;
        assert!(!sink.text().contains("(yes/no)"));
        type_line(&tx, "exit");
        finish(h).await.unwrap();

        let mut bad = password_connect(fx.port, "pw1");
        bad.pinned_fp = Some("SHA256:wrong".into());
        let (sink, _tx, h) = spawn_run(bad, known);
        assert!(finish(h).await.is_err());
        assert!(sink.text().contains("DOES NOT MATCH"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn key_login_uses_a_saved_passphrase_and_asks_when_none_is_saved() {
        let g = crate::ssh_keygen::generate(crate::ssh_keygen::Kind::Ed25519, Some("pp"), "me").unwrap();
        let fx = start_server("unused", Some(g.public_key.clone())).await;
        let (known, dir) = temp_known();
        known.remember("127.0.0.1", fx.port, "ssh-ed25519", &fx.host_fp).unwrap();

        // saved passphrase: no questions at all
        let (sink, tx, h) = spawn_run(key_connect(fx.port, &g.private_key, Some("pp")), known.clone());
        sink.wait_for("welcome").await;
        assert!(!sink.text().contains("passphrase"));
        type_line(&tx, "exit");
        finish(h).await.unwrap();

        // nothing saved: it asks, a wrong answer is retried, the right one signs in
        let (sink, tx, h) = spawn_run(key_connect(fx.port, &g.private_key, None), known);
        sink.wait_for("Enter passphrase").await;
        type_line(&tx, "nope");
        sink.wait_for("Wrong passphrase").await;
        type_line(&tx, "pp");
        sink.wait_for("welcome").await;
        assert!(!sink.text().contains("nope"), "a typed passphrase is never echoed");
        type_line(&tx, "exit");
        finish(h).await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_key_the_server_does_not_know_is_refused() {
        let allowed = crate::ssh_keygen::generate(crate::ssh_keygen::Kind::Ed25519, None, "").unwrap();
        let other = crate::ssh_keygen::generate(crate::ssh_keygen::Kind::Ed25519, None, "").unwrap();
        let fx = start_server("unused", Some(allowed.public_key)).await;
        let (known, dir) = temp_known();
        known.remember("127.0.0.1", fx.port, "ssh-ed25519", &fx.host_fp).unwrap();
        let (_s, _t, h) = spawn_run(key_connect(fx.port, &other.private_key, None), known);
        let err = finish(h).await.unwrap_err();
        assert!(err.contains("publickey"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_jump_host_forwards_to_the_target() {
        let target = start_server("pw1", None).await;
        let jump = start_server("pw1", None).await;
        let (known, dir) = temp_known();
        known.remember("127.0.0.1", target.port, "ssh-ed25519", &target.host_fp).unwrap();
        known.remember("127.0.0.1", jump.port, "ssh-ed25519", &jump.host_fp).unwrap();
        let mut c = password_connect(target.port, "pw1");
        c.jump = Some(Jump { user: "alice".into(), host: "127.0.0.1".into(), port: jump.port });
        let (sink, tx, h) = spawn_run(c, known);
        sink.wait_for("welcome").await;
        assert!(sink.text().contains("through it"));
        assert_eq!(target.seen.sizes.lock().unwrap().len(), 1, "the shell is on the target");
        assert!(jump.seen.sizes.lock().unwrap().is_empty(), "not on the jump host");
        type_line(&tx, "exit");
        finish(h).await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn closing_the_terminal_ends_the_session() {
        let fx = start_server("pw1", None).await;
        let (known, dir) = temp_known();
        known.remember("127.0.0.1", fx.port, "ssh-ed25519", &fx.host_fp).unwrap();
        let (sink, tx, h) = spawn_run(password_connect(fx.port, "pw1"), known);
        sink.wait_for("welcome").await;
        drop(tx);
        finish(h).await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_rsa_key_signs_in_too() {
        let g = crate::ssh_keygen::generate(crate::ssh_keygen::Kind::Rsa(2048), None, "me").unwrap();
        let fx = start_server("unused", Some(g.public_key.clone())).await;
        let (known, dir) = temp_known();
        known.remember("127.0.0.1", fx.port, "ssh-ed25519", &fx.host_fp).unwrap();
        let (sink, tx, h) = spawn_run(key_connect(fx.port, &g.private_key, None), known);
        sink.wait_for("welcome").await;
        type_line(&tx, "exit");
        finish(h).await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Against a real OpenSSH-family server: `cargo test --lib real_world -- --ignored --nocapture`.
    /// github.com accepts SSH logins only with a registered key, so a random key must be refused with
    /// "publickey" after the key exchange, the host-key question and the key offer all worked.
    #[tokio::test]
    #[ignore]
    async fn real_world_handshake_with_github() {
        let g = crate::ssh_keygen::generate(crate::ssh_keygen::Kind::Ed25519, None, "").unwrap();
        let (known, dir) = temp_known();
        let c = Connect { title: "t".into(), host: "github.com".into(), port: 22, user: "git".into(), jump: None, pinned_fp: None, auth: Auth::Key,
                          key: Some(Zeroizing::new(g.private_key)), passphrase: None, password: None };
        let (sink, tx, h) = spawn_run(c, known);
        sink.wait_for("(yes/no)").await;
        eprintln!("{}", sink.text());
        type_line(&tx, "yes");
        let err = finish(h).await.unwrap_err();
        eprintln!("result: {err}");
        assert!(err.contains("publickey"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
