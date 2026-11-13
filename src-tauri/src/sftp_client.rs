//! Built-in SFTP client for the remote file manager (no `sftp` program, nothing to install on either side).
//!
//! It signs in exactly like the terminal does (`ssh_client::establish`: same vault entry, same host-key rules,
//! same jump host), then opens the `sftp` subsystem on that connection. There is nobody to answer a question,
//! so a host the terminal hasn't trusted yet, a key passphrase that isn't saved or a one-time code ends the
//! attempt with a message saying to open the server in the terminal once.
//!
//! [`Sftp`] holds one session and is tested against an in-process server; the Tauri commands at the bottom keep
//! sessions by id and report transfer progress as `sftp-progress` events. Secrets stay in the backend.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh_client::{establish, unattended, Conn, Connect, KnownHosts, Sink};

const CHUNK: usize = 128 * 1024;
/// Deepest folder `remove` will walk into (a symlink loop can't make it run forever; links aren't followed anyway).
const MAX_DEPTH: u32 = 64;
/// What a transfer says when the user stopped it.
pub const CANCELLED: &str = "cancelled";
/// What a transfer says when the target is already there and overwriting wasn't asked for.
pub const EXISTS: &str = "already_exists";

// ── opening a session ────────────────────────────────────────────────────────

/// Collects what the sign-in code would have printed in a terminal, to explain a failure.
#[derive(Default)]
struct Notes(std::sync::Mutex<String>);

impl Sink for Notes {
    fn out(&self, data: &[u8]) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push_str(&String::from_utf8_lossy(data));
    }
}

impl Notes {
    fn text(&self) -> String { self.0.lock().unwrap_or_else(|e| e.into_inner()).clone() }
}

/// Text without terminal colour codes and carriage returns.
fn plain(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() { if n.is_ascii_alphabetic() { break; } }
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// The message for a failed sign-in: the terminal's own explanation, or a pointer to the terminal for the
/// things only a person at a prompt can answer.
fn explain(notes: &str, err: String) -> String {
    if notes.contains("can't be established") {
        return "This server isn't a trusted host yet. Open it in the terminal once and accept its fingerprint, then open the file manager again.".into();
    }
    if notes.contains("Enter passphrase") || notes.contains("didn't unlock this key") {
        return "This key is protected by a passphrase that isn't saved with the entry. Save it in the entry, or open the server in the terminal once.".into();
    }
    if err == "Cancelled." {
        return "The server asked a question that only the terminal can answer (a one-time code?). Use the terminal for this server.".into();
    }
    // A refused or changed host key was explained in the notes; keep the first line of it.
    if notes.contains("HOST KEY") {
        if let Some(first) = plain(notes).lines().find(|l| l.contains("HOST KEY")) { return first.trim().to_string(); }
    }
    err
}

/// One open SFTP session. Dropping it closes the connection.
pub struct Sftp {
    sftp: SftpSession,
    _conn: Conn,
    _jump: Option<Conn>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Entry {
    pub name: String,
    /// `dir`, `file` or `other` (a link shows what it points at).
    pub kind: &'static str,
    pub link: bool,
    pub size: u64,
    /// Seconds since 1970.
    pub mtime: Option<u32>,
    /// Permission bits only (`0o755`).
    pub mode: Option<u32>,
}

#[derive(Serialize, Debug)]
pub struct Listing {
    /// The folder, as the server spells it (`..` and `~` resolved).
    pub path: String,
    pub entries: Vec<Entry>,
}

fn kind_of(a: &FileAttributes) -> &'static str {
    if a.is_dir() { "dir" } else if a.is_regular() { "file" } else { "other" }
}

fn nice(e: impl std::fmt::Display) -> String {
    let t = e.to_string();
    match t.as_str() {
        "No such file" => "That file or folder doesn't exist.".into(),
        "Permission denied" => "Permission denied.".into(),
        _ => t,
    }
}

/// Connects and signs in for `c`, then starts the SFTP subsystem.
pub async fn open(c: Connect, known: KnownHosts) -> Result<Sftp, String> {
    let notes = Arc::new(Notes::default());
    let sink: Arc<dyn Sink> = notes.clone();
    let prompter = unattended(sink.clone());
    let (conn, jump) = establish(&c, &known, &prompter, &sink).await.map_err(|e| explain(&notes.text(), e))?;
    let ch = conn.channel_open_session().await.map_err(|e| format!("Couldn't open a session: {e}"))?;
    ch.request_subsystem(true, "sftp").await.map_err(|_| "This server doesn't offer SFTP.".to_string())?;
    let sftp = SftpSession::new(ch.into_stream()).await.map_err(|e| format!("The server's SFTP service didn't start: {}", nice(e)))?;
    Ok(Sftp { sftp, _conn: conn, _jump: jump })
}

impl Sftp {
    /// The home folder, where the file manager starts.
    pub async fn home(&self) -> Result<String, String> {
        self.sftp.canonicalize(".").await.map_err(nice)
    }

    /// The folder's contents: folders first, then files, each sorted by name.
    pub async fn list(&self, path: &str) -> Result<Listing, String> {
        let want = if path.is_empty() || path == "~" { "." } else { path };
        let real = self.sftp.canonicalize(want).await.map_err(nice)?;
        let mut entries = Vec::new();
        for e in self.sftp.read_dir(real.as_str()).await.map_err(nice)? {
            let name = e.file_name();
            if name == "." || name == ".." { continue; }
            let m = e.metadata();
            let mut attrs = m.clone();
            let link = e.file_type().is_symlink();
            if link {
                // What a link points at decides how it shows; a broken link stays "other".
                attrs = match self.sftp.metadata(e.path()).await { Ok(t) => t, Err(_) => FileAttributes::default() };
            }
            entries.push(Entry {
                name, kind: kind_of(&attrs), link, size: attrs.size.unwrap_or(0),
                mtime: m.mtime, mode: m.permissions.map(|p| p & 0o7777),
            });
        }
        entries.sort_by(|a, b| {
            (b.kind == "dir").cmp(&(a.kind == "dir")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name))
        });
        Ok(Listing { path: real, entries })
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        self.sftp.create_dir(path).await.map_err(nice)
    }

    /// Renames or moves; the server refuses when the new name is taken.
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        self.sftp.rename(from, to).await.map_err(nice)
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> Result<(), String> {
        let attrs = FileAttributes { permissions: Some(mode & 0o7777), ..FileAttributes::default() };
        self.sftp.set_metadata(path, attrs).await.map_err(nice)
    }

    /// Deletes a file or link, or a folder with everything in it. Links are removed, never followed.
    pub async fn remove(&self, path: &str) -> Result<(), String> {
        self.remove_at(path.to_string(), 0).await
    }

    fn remove_at<'a>(&'a self, path: String, depth: u32) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            let m = self.sftp.symlink_metadata(path.as_str()).await.map_err(nice)?;
            if !m.is_dir() {
                return self.sftp.remove_file(path.as_str()).await.map_err(nice);
            }
            if depth >= MAX_DEPTH { return Err("That folder is nested too deeply to delete here.".into()); }
            let children: Vec<String> = self.sftp.read_dir(path.as_str()).await.map_err(nice)?
                .filter(|e| e.file_name() != "." && e.file_name() != "..").map(|e| e.path()).collect();
            for child in children { self.remove_at(child, depth + 1).await?; }
            self.sftp.remove_dir(path.as_str()).await.map_err(nice)
        })
    }

    /// Copies a remote file to `local`, reporting `(done, total)` bytes. A half-written file never takes the
    /// target's place: it is written beside it and renamed at the end.
    pub async fn download(&self, remote: &str, local: &Path, overwrite: bool, progress: &(dyn Fn(u64, u64) + Sync), cancel: &AtomicBool) -> Result<u64, String> {
        let meta = self.sftp.metadata(remote).await.map_err(nice)?;
        if meta.is_dir() { return Err("Folders can't be downloaded yet; open it and pick files.".into()); }
        if !overwrite && tokio::fs::try_exists(local).await.unwrap_or(false) { return Err(EXISTS.into()); }
        let total = meta.size.unwrap_or(0);
        let mut src = self.sftp.open(remote).await.map_err(nice)?;
        let mut part = local.as_os_str().to_owned();
        part.push(".notiq-part");
        let part = std::path::PathBuf::from(part);
        let result: Result<u64, String> = async {
            let mut out = tokio::fs::File::create(&part).await.map_err(|e| format!("Couldn't write {}: {e}", local.display()))?;
            let mut buf = vec![0u8; CHUNK];
            let mut done = 0u64;
            progress(0, total);
            loop {
                if cancel.load(Ordering::Relaxed) { return Err(CANCELLED.into()); }
                let n = src.read(&mut buf).await.map_err(|e| format!("The download stopped: {e}"))?;
                if n == 0 { break; }
                out.write_all(&buf[..n]).await.map_err(|e| format!("Couldn't write {}: {e}", local.display()))?;
                done += n as u64;
                progress(done, total.max(done));
            }
            out.flush().await.map_err(|e| e.to_string())?;
            drop(out);
            tokio::fs::rename(&part, local).await.map_err(|e| format!("Couldn't save {}: {e}", local.display()))?;
            Ok(done)
        }.await;
        let _ = src.shutdown().await;
        if result.is_err() { let _ = tokio::fs::remove_file(&part).await; }
        result
    }

    /// Copies `local` to the server at `remote`. A cancelled or failed upload removes the partial file.
    pub async fn upload(&self, local: &Path, remote: &str, overwrite: bool, progress: &(dyn Fn(u64, u64) + Sync), cancel: &AtomicBool) -> Result<u64, String> {
        let meta = tokio::fs::metadata(local).await.map_err(|e| format!("Couldn't read {}: {e}", local.display()))?;
        if meta.is_dir() { return Err("Folders can't be uploaded yet; pick files.".into()); }
        if !overwrite && self.sftp.try_exists(remote).await.unwrap_or(false) { return Err(EXISTS.into()); }
        let total = meta.len();
        let mut input = tokio::fs::File::open(local).await.map_err(|e| format!("Couldn't read {}: {e}", local.display()))?;
        let mut dst = self.sftp.open_with_flags(remote, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE).await.map_err(nice)?;
        let result: Result<u64, String> = async {
            let mut buf = vec![0u8; CHUNK];
            let mut done = 0u64;
            progress(0, total);
            loop {
                if cancel.load(Ordering::Relaxed) { return Err(CANCELLED.into()); }
                let n = input.read(&mut buf).await.map_err(|e| format!("Couldn't read {}: {e}", local.display()))?;
                if n == 0 { break; }
                dst.write_all(&buf[..n]).await.map_err(|e| format!("The upload stopped: {e}"))?;
                done += n as u64;
                progress(done, total.max(done));
            }
            dst.flush().await.map_err(|e| format!("The upload stopped: {e}"))?;
            Ok(done)
        }.await;
        let _ = dst.shutdown().await;
        if result.is_err() { let _ = self.sftp.remove_file(remote).await; }
        result
    }
}

// ── the commands ─────────────────────────────────────────────────────────────

#[cfg(desktop)]
mod commands {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use tauri::{AppHandle, Emitter, Manager, State};

    use super::*;

    /// Open file-manager sessions and running transfers, by the ids the web view picked.
    #[derive(Default)]
    pub struct SftpState {
        sessions: Mutex<HashMap<u32, Arc<Sftp>>>,
        transfers: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    }

    impl SftpState {
        fn session(&self, id: u32) -> Result<Arc<Sftp>, String> {
            self.sessions.lock().unwrap_or_else(|e| e.into_inner()).get(&id).cloned()
                .ok_or_else(|| "The connection to the server was closed. Reconnect to continue.".to_string())
        }
    }

    #[derive(Serialize)]
    pub struct Opened { title: String, home: String }

    #[tauri::command]
    pub async fn sftp_open(id: u32, path: String, auth: String, app: AppHandle, state: State<'_, SftpState>,
                           vault: State<'_, crate::vault::VaultState>) -> Result<Opened, String> {
        let session = crate::ssh_connect::load_session(&vault, &path, crate::ssh_connect::Auth::parse(&auth)?)?;
        let title = session.title.clone();
        let connect = Connect::from_session(session)?;
        let known = KnownHosts::new(app.path().app_data_dir().map_err(|e| e.to_string())?.join("ssh_known_hosts.json"));
        let sftp = Arc::new(open(connect, known).await?);
        let home = sftp.home().await?;
        state.sessions.lock().unwrap_or_else(|e| e.into_inner()).insert(id, sftp);
        Ok(Opened { title, home })
    }

    #[tauri::command]
    pub fn sftp_close(id: u32, state: State<'_, SftpState>) {
        state.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }

    #[tauri::command]
    pub async fn sftp_list(id: u32, path: String, state: State<'_, SftpState>) -> Result<Listing, String> {
        state.session(id)?.list(&path).await
    }

    #[tauri::command]
    pub async fn sftp_mkdir(id: u32, path: String, state: State<'_, SftpState>) -> Result<(), String> {
        state.session(id)?.mkdir(&path).await
    }

    #[tauri::command]
    pub async fn sftp_rename(id: u32, from: String, to: String, state: State<'_, SftpState>) -> Result<(), String> {
        state.session(id)?.rename(&from, &to).await
    }

    #[tauri::command]
    pub async fn sftp_chmod(id: u32, path: String, mode: u32, state: State<'_, SftpState>) -> Result<(), String> {
        state.session(id)?.chmod(&path, mode).await
    }

    #[tauri::command]
    pub async fn sftp_remove(id: u32, path: String, state: State<'_, SftpState>) -> Result<(), String> {
        state.session(id)?.remove(&path).await
    }

    /// Stops a running transfer; the transfer's own command then returns `cancelled`.
    #[tauri::command]
    pub fn sftp_cancel(transfer: u32, state: State<'_, SftpState>) {
        if let Some(flag) = state.transfers.lock().unwrap_or_else(|e| e.into_inner()).get(&transfer) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    #[derive(Serialize, Clone)]
    struct ProgressEvent { transfer: u32, done: u64, total: u64 }

    /// Runs `job` with a cancel flag and a progress callback that tells the web view at most ~10 times a second.
    async fn transfer<F, Fut>(transfer: u32, app: &AppHandle, state: &SftpState, job: F) -> Result<u64, String>
    where F: FnOnce(Arc<AtomicBool>, Arc<dyn Fn(u64, u64) + Send + Sync>) -> Fut, Fut: Future<Output = Result<u64, String>> {
        let cancel = Arc::new(AtomicBool::new(false));
        state.transfers.lock().unwrap_or_else(|e| e.into_inner()).insert(transfer, cancel.clone());
        let last = Mutex::new(Instant::now() - Duration::from_secs(1));
        let handle = app.clone();
        let progress: Arc<dyn Fn(u64, u64) + Send + Sync> = Arc::new(move |done, total| {
            let mut t = last.lock().unwrap_or_else(|e| e.into_inner());
            if done < total && t.elapsed() < Duration::from_millis(100) { return; }
            *t = Instant::now();
            let _ = handle.emit("sftp-progress", ProgressEvent { transfer, done, total });
        });
        let result = job(cancel, progress).await;
        state.transfers.lock().unwrap_or_else(|e| e.into_inner()).remove(&transfer);
        result
    }

    #[tauri::command]
    pub async fn sftp_download(id: u32, transfer_id: u32, remote: String, local: String, overwrite: bool, app: AppHandle,
                               state: State<'_, SftpState>) -> Result<u64, String> {
        let s = state.session(id)?;
        transfer(transfer_id, &app, &state, |cancel, progress| async move {
            s.download(&remote, Path::new(&local), overwrite, &*progress, &cancel).await
        }).await
    }

    #[tauri::command]
    pub async fn sftp_upload(id: u32, transfer_id: u32, local: String, remote: String, overwrite: bool, app: AppHandle,
                             state: State<'_, SftpState>) -> Result<u64, String> {
        let s = state.session(id)?;
        transfer(transfer_id, &app, &state, |cancel, progress| async move {
            s.upload(Path::new(&local), &remote, overwrite, &*progress, &cancel).await
        }).await
    }
}

#[cfg(desktop)]
pub use commands::*;

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::path::PathBuf;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    use russh::keys::HashAlg;
    use russh::server::{self, Msg, Server as _, Session};
    use russh::{Channel, ChannelId};
    use russh_sftp::protocol::{Attrs, Data, File, FileMode, Handle, Name, Status, StatusCode, Version};
    use tokio::net::TcpListener;
    use zeroize::Zeroizing;

    use crate::ssh_connect::Auth;

    // A small SFTP server over a real temp folder.

    enum Open { File(std::fs::File), Dir(Option<Vec<File>>) }

    struct Fs { root: PathBuf, handles: HashMap<String, Open>, next: u32 }

    fn attrs_of(m: &std::fs::Metadata) -> FileAttributes {
        let mut a = FileAttributes::from(m);
        a.permissions = Some(0o644 | if m.is_dir() { FileMode::DIR.bits() } else { FileMode::REG.bits() });
        a
    }

    fn ok(id: u32) -> Status { Status { id, status_code: StatusCode::Ok, error_message: "Ok".into(), language_tag: "en".into() } }

    fn io_status(e: std::io::Error) -> StatusCode {
        match e.kind() {
            std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
            std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
            _ => StatusCode::Failure,
        }
    }

    impl Fs {
        fn path(&self, p: &str) -> PathBuf { self.root.join(p.trim_start_matches('/')) }
        fn handle(&mut self, o: Open) -> String { self.next += 1; let h = format!("h{}", self.next); self.handles.insert(h.clone(), o); h }
    }

    impl russh_sftp::server::Handler for Fs {
        type Error = StatusCode;
        fn unimplemented(&self) -> Self::Error { StatusCode::OpUnsupported }

        async fn init(&mut self, _v: u32, _e: HashMap<String, String>) -> Result<Version, Self::Error> { Ok(Version::new()) }

        async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
            let p = if path == "." || path.is_empty() { "/".to_string() } else { format!("/{}", path.trim_matches('/')) };
            Ok(Name { id, files: vec![File::dummy(p)] })
        }

        async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
            let dir = self.path(&path);
            let mut files = Vec::new();
            for e in std::fs::read_dir(&dir).map_err(io_status)? {
                let e = e.map_err(io_status)?;
                let m = e.metadata().map_err(io_status)?;
                files.push(File::new(e.file_name().to_string_lossy().into_owned(), attrs_of(&m)));
            }
            Ok(Handle { id, handle: self.handle(Open::Dir(Some(files))) })
        }

        async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
            match self.handles.get_mut(&handle) {
                Some(Open::Dir(files)) => match files.take() { Some(f) => Ok(Name { id, files: f }), None => Err(StatusCode::Eof) },
                _ => Err(StatusCode::Failure),
            }
        }

        async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
            let m = std::fs::metadata(self.path(&path)).map_err(io_status)?;
            Ok(Attrs { id, attrs: attrs_of(&m) })
        }
        async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> { self.stat(id, path).await }

        async fn open(&mut self, id: u32, filename: String, pflags: OpenFlags, _a: FileAttributes) -> Result<Handle, Self::Error> {
            let f = std::fs::OpenOptions::from(pflags).open(self.path(&filename)).map_err(io_status)?;
            Ok(Handle { id, handle: self.handle(Open::File(f)) })
        }

        async fn read(&mut self, id: u32, handle: String, offset: u64, len: u32) -> Result<Data, Self::Error> {
            let Some(Open::File(f)) = self.handles.get_mut(&handle) else { return Err(StatusCode::Failure) };
            f.seek(SeekFrom::Start(offset)).map_err(io_status)?;
            let mut buf = vec![0u8; len as usize];
            let n = f.read(&mut buf).map_err(io_status)?;
            if n == 0 { return Err(StatusCode::Eof); }
            buf.truncate(n);
            Ok(Data { id, data: buf })
        }

        async fn write(&mut self, id: u32, handle: String, offset: u64, data: Vec<u8>) -> Result<Status, Self::Error> {
            let Some(Open::File(f)) = self.handles.get_mut(&handle) else { return Err(StatusCode::Failure) };
            f.seek(SeekFrom::Start(offset)).map_err(io_status)?;
            f.write_all(&data).map_err(io_status)?;
            Ok(ok(id))
        }

        async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> { self.handles.remove(&handle); Ok(ok(id)) }

        async fn mkdir(&mut self, id: u32, path: String, _a: FileAttributes) -> Result<Status, Self::Error> {
            std::fs::create_dir(self.path(&path)).map_err(io_status)?; Ok(ok(id))
        }
        async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
            std::fs::remove_dir(self.path(&path)).map_err(io_status)?; Ok(ok(id))
        }
        async fn remove(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
            std::fs::remove_file(self.path(&path)).map_err(io_status)?; Ok(ok(id))
        }
        async fn rename(&mut self, id: u32, from: String, to: String) -> Result<Status, Self::Error> {
            if self.path(&to).exists() { return Err(StatusCode::Failure); }
            std::fs::rename(self.path(&from), self.path(&to)).map_err(io_status)?; Ok(ok(id))
        }
    }

    #[derive(Clone)]
    struct Srv { root: PathBuf, chans: Arc<StdMutex<HashMap<ChannelId, Channel<Msg>>>>, sftp_on: bool }

    impl server::Server for Srv {
        type Handler = Self;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self { self.clone() }
    }

    impl server::Handler for Srv {
        type Error = russh::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<server::Auth, Self::Error> {
            Ok(if user == "alice" && password == "pw" { server::Auth::Accept } else { server::Auth::reject() })
        }

        async fn channel_open_session(&mut self, c: Channel<Msg>, reply: server::ChannelOpenHandle, _s: &mut Session) -> Result<(), Self::Error> {
            self.chans.lock().unwrap().insert(c.id(), c);
            reply.accept().await;
            Ok(())
        }

        async fn subsystem_request(&mut self, id: ChannelId, name: &str, session: &mut Session) -> Result<(), Self::Error> {
            let ch = self.chans.lock().unwrap().remove(&id);
            match (name, ch) {
                ("sftp", Some(ch)) if self.sftp_on => {
                    let _ = session.channel_success(id);
                    let fs = Fs { root: self.root.clone(), handles: HashMap::new(), next: 0 };
                    tokio::spawn(async move { russh_sftp::server::run(ch.into_stream(), fs).await; });
                }
                _ => { let _ = session.channel_failure(id); }
            }
            Ok(())
        }
    }

    struct Fixture { port: u16, fp: String, root: PathBuf }

    fn temp_root(tag: &str) -> PathBuf {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("notiq-sftp-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    async fn start(sftp_on: bool) -> Fixture {
        let pem = crate::ssh_keygen::generate(crate::ssh_keygen::Kind::Ed25519, None, "").unwrap().private_key;
        let host_key = russh::keys::PrivateKey::from_openssh(&pem).unwrap();
        let fp = host_key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let cfg = Arc::new(server::Config {
            keys: vec![host_key],
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            ..Default::default()
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let root = temp_root("srv");
        let mut srv = Srv { root: root.clone(), chans: Default::default(), sftp_on };
        tokio::spawn(async move { let _ = srv.run_on_socket(cfg, &listener).await; });
        Fixture { port, fp, root }
    }

    fn connect(port: u16, pinned: Option<String>) -> Connect {
        Connect {
            title: "test".into(), host: "127.0.0.1".into(), port, user: "alice".into(), jump: None, pinned_fp: pinned,
            auth: Auth::Password, key: None, passphrase: None, password: Some(Zeroizing::new("pw".into())),
        }
    }

    fn known() -> KnownHosts { KnownHosts::new(temp_root("known").join("known.json")) }

    async fn session(f: &Fixture) -> Sftp { open(connect(f.port, Some(f.fp.clone())), known()).await.expect("sign in") }

    fn no_progress() -> impl Fn(u64, u64) + Sync { |_, _| {} }

    #[tokio::test]
    async fn lists_folders_first_then_files_by_name() {
        let f = start(true).await;
        std::fs::write(f.root.join("b.txt"), "bb").unwrap();
        std::fs::write(f.root.join("A.txt"), "a").unwrap();
        std::fs::create_dir(f.root.join("zdir")).unwrap();
        let s = session(&f).await;
        assert_eq!(s.home().await.unwrap(), "/");
        let l = s.list("/").await.unwrap();
        let names: Vec<_> = l.entries.iter().map(|e| (e.name.as_str(), e.kind, e.size)).collect();
        assert_eq!(names, vec![("zdir", "dir", 0), ("A.txt", "file", 1), ("b.txt", "file", 2)]);
        assert!(s.list("/nope").await.is_err());
    }

    #[tokio::test]
    async fn downloads_a_big_file_with_progress_and_no_leftovers() {
        let f = start(true).await;
        let data: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(f.root.join("big.bin"), &data).unwrap();
        let s = session(&f).await;
        let out = temp_root("dl").join("big.bin");
        let seen = StdMutex::new(Vec::new());
        let progress = |d: u64, t: u64| seen.lock().unwrap().push((d, t));
        let n = s.download("/big.bin", &out, false, &progress, &AtomicBool::new(false)).await.unwrap();
        assert_eq!(n, data.len() as u64);
        assert_eq!(std::fs::read(&out).unwrap(), data);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.last(), Some(&(data.len() as u64, data.len() as u64)));
        assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0), "progress only moves forward");
        assert!(!out.with_file_name("big.bin.notiq-part").exists());
        // A second download won't replace it unless asked.
        let again = s.download("/big.bin", &out, false, &no_progress(), &AtomicBool::new(false)).await;
        assert_eq!(again.unwrap_err(), EXISTS);
        assert!(s.download("/big.bin", &out, true, &no_progress(), &AtomicBool::new(false)).await.is_ok());
    }

    #[tokio::test]
    async fn uploads_and_refuses_to_overwrite_unless_asked() {
        let f = start(true).await;
        let s = session(&f).await;
        let local = temp_root("up").join("hello.txt");
        std::fs::write(&local, "hello world").unwrap();
        assert_eq!(s.upload(&local, "/hello.txt", false, &no_progress(), &AtomicBool::new(false)).await.unwrap(), 11);
        assert_eq!(std::fs::read_to_string(f.root.join("hello.txt")).unwrap(), "hello world");
        std::fs::write(&local, "new").unwrap();
        assert_eq!(s.upload(&local, "/hello.txt", false, &no_progress(), &AtomicBool::new(false)).await.unwrap_err(), EXISTS);
        assert_eq!(std::fs::read_to_string(f.root.join("hello.txt")).unwrap(), "hello world");
        s.upload(&local, "/hello.txt", true, &no_progress(), &AtomicBool::new(false)).await.unwrap();
        assert_eq!(std::fs::read_to_string(f.root.join("hello.txt")).unwrap(), "new");
    }

    #[tokio::test]
    async fn a_cancelled_transfer_leaves_nothing_behind() {
        let f = start(true).await;
        std::fs::write(f.root.join("x.bin"), vec![7u8; 300_000]).unwrap();
        let s = session(&f).await;
        let out = temp_root("cx").join("x.bin");
        let cancel = AtomicBool::new(true);
        assert_eq!(s.download("/x.bin", &out, false, &no_progress(), &cancel).await.unwrap_err(), CANCELLED);
        assert!(!out.exists() && !out.with_file_name("x.bin.notiq-part").exists());
        let local = temp_root("cu").join("y.bin");
        std::fs::write(&local, vec![1u8; 300_000]).unwrap();
        assert_eq!(s.upload(&local, "/y.bin", false, &no_progress(), &cancel).await.unwrap_err(), CANCELLED);
        assert!(!f.root.join("y.bin").exists());
    }

    #[tokio::test]
    async fn makes_renames_and_deletes_folders_with_contents() {
        let f = start(true).await;
        let s = session(&f).await;
        s.mkdir("/proj").await.unwrap();
        s.mkdir("/proj/sub").await.unwrap();
        std::fs::write(f.root.join("proj/sub/a.txt"), "a").unwrap();
        std::fs::write(f.root.join("proj/b.txt"), "b").unwrap();
        s.rename("/proj/b.txt", "/proj/c.txt").await.unwrap();
        assert!(f.root.join("proj/c.txt").exists());
        assert!(s.rename("/proj/c.txt", "/proj/sub").await.is_err(), "a taken name is refused");
        s.remove("/proj").await.unwrap();
        assert!(!f.root.join("proj").exists());
        assert!(s.remove("/proj").await.is_err());
    }

    #[tokio::test]
    async fn an_untrusted_host_points_to_the_terminal() {
        let f = start(true).await;
        let e = open(connect(f.port, None), known()).await.err().expect("must not connect");
        assert!(e.contains("terminal"), "{e}");
        // Once the terminal has trusted it, the file manager connects without asking.
        let k = known();
        k.remember("127.0.0.1", f.port, "ssh-ed25519", &f.fp).unwrap();
        assert!(open(connect(f.port, None), k).await.is_ok());
    }

    #[tokio::test]
    async fn a_wrong_fingerprint_or_password_or_missing_sftp_is_an_error() {
        let f = start(true).await;
        let e = open(connect(f.port, Some("SHA256:AAAA".into())), known()).await.err().unwrap();
        assert!(e.contains("HOST KEY DOES NOT MATCH"), "{e}");
        let mut c = connect(f.port, Some(f.fp.clone()));
        c.password = Some(Zeroizing::new("wrong".into()));
        assert!(open(c, known()).await.err().unwrap().contains("Permission denied"));
        let g = start(false).await;
        let e = open(connect(g.port, Some(g.fp.clone())), known()).await.err().unwrap();
        assert!(e.contains("SFTP"), "{e}");
    }

    #[test]
    fn terminal_codes_are_stripped_from_notes() {
        assert_eq!(plain("\r\n\x1b[31mHOST KEY X\x1b[0m\r\nmore"), "HOST KEY X\nmore");
    }
}
