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
/// What reading a file for the viewer says when it is bigger than the viewer allows.
pub const TOO_BIG: &str = "too_big";
/// What saving an edited file says when it changed on the server after it was opened.
pub const CHANGED: &str = "changed";
/// What moving an item to the Trash says when the server can't (another disk, no permission): the UI offers to delete it for good.
pub const TRASH_FAILED: &str = "trash_failed";
/// What a folder transfer says when the destination folder is already there and no merge mode was given.
pub const EXISTS_DIR: &str = "already_exists_folder";

/// How a folder transfer treats files that are already in the destination folder.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Merge {
    /// Keep the files that are already there; copy only what is missing.
    Skip,
    /// Overwrite the files that are already there.
    Replace,
}

impl Merge {
    pub fn parse(s: &str) -> Option<Merge> {
        match s { "skip" => Some(Merge::Skip), "replace" => Some(Merge::Replace), _ => None }
    }
}

/// What moving an item does when something already has the target's name.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OnConflict {
    Fail,
    /// The existing item goes to the Trash (or is deleted when `use_trash` is off), then the move happens.
    Replace,
    /// The moved item gets a free name, `name (2).ext`.
    KeepBoth,
}

impl OnConflict {
    pub fn parse(s: &str) -> Option<OnConflict> {
        match s { "fail" => Some(OnConflict::Fail), "replace" => Some(OnConflict::Replace), "keep_both" => Some(OnConflict::KeepBoth), _ => None }
    }
}

/// `name (2).ext` for `n = 2`: the number goes before the extension (a leading dot isn't one).
fn numbered(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{} ({n}){}", &name[..i], &name[i..]),
        _ => format!("{name} ({n})"),
    }
}

/// A name from the server that can safely become one part of a local path.
fn local_component(name: &str) -> Result<&str, String> {
    let bad_everywhere = name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0');
    let bad_here = cfg!(windows) && name.chars().any(|c| matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'));
    if bad_everywhere || bad_here { Err(format!("\u{201c}{name}\u{201d} has a name that can't be saved on this computer.")) } else { Ok(name) }
}

/// Everything under a folder, found before copying so the progress has a total.
#[derive(Default, Debug)]
struct Plan {
    /// Folders below the root, as `a/b` (parents first).
    dirs: Vec<String>,
    /// Files with their size, as `a/b/c.txt`.
    files: Vec<(String, u64)>,
    total: u64,
}
/// The server's Trash, in the freedesktop.org layout (`files/` holds the items, `info/` one `.trashinfo` each), so a
/// Linux file manager on the server sees and restores them too. Relative to the home folder.
const TRASH_REL: &str = ".local/share/Trash";

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

/// A whole file read for the in-app viewer.
#[derive(Debug)]
pub struct Content {
    pub data: Vec<u8>,
    /// Seconds since 1970; saving compares it to notice a change made elsewhere.
    pub mtime: Option<u32>,
}

/// One item in the server's Trash.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct TrashItem {
    /// Its name inside the Trash; what restoring and deleting for good take.
    pub id: String,
    /// The path it was deleted from.
    pub original: String,
    /// Seconds since 1970 (UTC), when it was deleted.
    pub deleted: Option<u64>,
    pub kind: &'static str,
    pub size: u64,
}

/// `%`-encodes everything but letters, digits and `-_.~/` (the `Path=` line of a `.trashinfo`).
fn pct_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { out.push(b as char); } else { out.push_str(&format!("%{b:02X}")); }
    }
    out
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { out.push(v); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Days since 1970-01-01 for a calendar date, and back (Howard Hinnant's civil-date algorithms).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) as i64 + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((yoe + era * 400 + if m <= 2 { 1 } else { 0 }), m, d)
}

/// `2026-11-13T12:30:05` (UTC) for seconds since 1970; the format of a `.trashinfo`'s `DeletionDate`.
fn iso_from_unix(secs: u64) -> String {
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let t = secs % 86_400;
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}", t / 3600, t % 3600 / 60, t % 60)
}

fn unix_from_iso(s: &str) -> Option<u64> {
    let (date, time) = s.trim().split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut t = time.split(':').map(|x| x.parse::<u64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    let days = days_from_civil(y, u32::try_from(m).ok()?, u32::try_from(day).ok()?);
    u64::try_from(days).ok().map(|dd| dd * 86_400 + hh * 3600 + mm * 60 + ss)
}

/// The `Path` and deletion time out of a `.trashinfo`'s text.
fn parse_trashinfo(text: &str) -> Option<(String, Option<u64>)> {
    let mut path = None;
    let mut when = None;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("Path=") { path = Some(pct_decode(v.trim())); }
        else if let Some(v) = line.strip_prefix("DeletionDate=") { when = unix_from_iso(v); }
    }
    path.map(|p| (p, when))
}

/// A name inside the Trash must be one plain name.
fn valid_trash_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id == "." || id == ".." || id.contains('/') { Err("That isn't an item in the Trash.".into()) } else { Ok(()) }
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
        "No such file" => "That file or folder no longer exists on the server.".into(),
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
    ch.request_subsystem(true, "sftp").await.map_err(|_| "SFTP isn't enabled on this server, so the file manager can't open it.".to_string())?;
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

    // ── the Trash ────────────────────────────────────────────────────────────

    /// `(files, info)` folders of the Trash, created when missing.
    async fn ensure_trash(&self) -> Result<(String, String), String> {
        let home = self.home().await?;
        let mut cur = home.trim_end_matches('/').to_string();
        for part in TRASH_REL.split('/').chain(["files"]) {
            cur = format!("{cur}/{part}");
            if !self.sftp.try_exists(cur.as_str()).await.unwrap_or(false) { self.sftp.create_dir(cur.as_str()).await.map_err(nice)?; }
        }
        let base = format!("{}/{}", home.trim_end_matches('/'), TRASH_REL);
        let info = format!("{base}/info");
        if !self.sftp.try_exists(info.as_str()).await.unwrap_or(false) { self.sftp.create_dir(info.as_str()).await.map_err(nice)?; }
        Ok((format!("{base}/files"), info))
    }

    /// Moves a file or folder to the server's Trash instead of deleting it. Fails with [`TRASH_FAILED`] when the server
    /// can't move it there (another disk, no permission).
    pub async fn trash(&self, path: &str) -> Result<(), String> {
        let path = path.trim_end_matches('/');
        let home = self.home().await?;
        if path.is_empty() || path == home.trim_end_matches('/') { return Err("The home folder can't be deleted.".into()); }
        if path.contains(&format!("/{TRASH_REL}")) { return Err("This is already in the Trash.".into()); }
        let (files, info) = self.ensure_trash().await?;
        let name = path.rsplit('/').next().unwrap_or(path);
        let mut id = name.to_string();
        let mut n = 1;
        while self.sftp.try_exists(format!("{files}/{id}")).await.unwrap_or(false) || self.sftp.try_exists(format!("{info}/{id}.trashinfo")).await.unwrap_or(false) {
            n += 1;
            id = format!("{name} ({n})");
            if n > 1000 { return Err(TRASH_FAILED.into()); }
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let note = format!("[Trash Info]\nPath={}\nDeletionDate={}\n", pct_encode(path), iso_from_unix(now));
        let info_path = format!("{info}/{id}.trashinfo");
        let mut f = self.sftp.open_with_flags(info_path.as_str(), OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE).await.map_err(|_| TRASH_FAILED.to_string())?;
        let written = f.write_all(note.as_bytes()).await;
        let _ = f.shutdown().await;
        if written.is_err() { let _ = self.sftp.remove_file(info_path.as_str()).await; return Err(TRASH_FAILED.into()); }
        if self.sftp.rename(path, format!("{files}/{id}")).await.is_err() {
            let _ = self.sftp.remove_file(info_path.as_str()).await;
            return Err(TRASH_FAILED.into());
        }
        Ok(())
    }

    /// What is in the Trash, newest first.
    pub async fn list_trash(&self) -> Result<Vec<TrashItem>, String> {
        let (files, info) = self.ensure_trash().await?;
        let mut items = Vec::new();
        let names: Vec<String> = self.sftp.read_dir(info.as_str()).await.map_err(nice)?
            .map(|e| e.file_name()).filter(|n| n.ends_with(".trashinfo")).collect();
        for n in names {
            let id = n.trim_end_matches(".trashinfo").to_string();
            let mut f = match self.sftp.open(format!("{info}/{n}")).await { Ok(f) => f, Err(_) => continue };
            let mut text = Vec::new();
            let _ = (&mut f).take(8192).read_to_end(&mut text).await;
            let _ = f.shutdown().await;
            let Some((original, deleted)) = parse_trashinfo(&String::from_utf8_lossy(&text)) else { continue };
            let Ok(meta) = self.sftp.symlink_metadata(format!("{files}/{id}")).await else { continue };
            items.push(TrashItem { id, original, deleted, kind: kind_of(&meta), size: meta.size.unwrap_or(0) });
        }
        items.sort_by(|a, b| b.deleted.cmp(&a.deleted).then_with(|| a.id.cmp(&b.id)));
        Ok(items)
    }

    /// Puts an item back where it was deleted from; refuses when something is there now.
    pub async fn restore(&self, id: &str) -> Result<(), String> {
        valid_trash_id(id)?;
        let (files, info) = self.ensure_trash().await?;
        let info_path = format!("{info}/{id}.trashinfo");
        let mut f = self.sftp.open(info_path.as_str()).await.map_err(nice)?;
        let mut text = Vec::new();
        let _ = (&mut f).take(8192).read_to_end(&mut text).await;
        let _ = f.shutdown().await;
        let (original, _) = parse_trashinfo(&String::from_utf8_lossy(&text)).ok_or("This Trash entry has no original location.")?;
        if self.sftp.try_exists(original.as_str()).await.unwrap_or(false) { return Err(EXISTS.into()); }
        self.sftp.rename(format!("{files}/{id}"), original.as_str()).await
            .map_err(|_| "Couldn't restore it: the original folder may no longer exist.".to_string())?;
        let _ = self.sftp.remove_file(info_path.as_str()).await;
        Ok(())
    }

    /// Deletes one item of the Trash for good.
    pub async fn purge(&self, id: &str) -> Result<(), String> {
        valid_trash_id(id)?;
        let (files, info) = self.ensure_trash().await?;
        let item = format!("{files}/{id}");
        if self.sftp.try_exists(item.as_str()).await.unwrap_or(false) { self.remove_at(item, 0).await?; }
        let _ = self.sftp.remove_file(format!("{info}/{id}.trashinfo")).await;
        Ok(())
    }

    pub async fn empty_trash(&self) -> Result<(), String> {
        for item in self.list_trash().await? { self.purge(&item.id).await?; }
        Ok(())
    }

    /// Reads a whole file (following links) for the viewer. Files over `limit` bytes aren't read.
    pub async fn read_file(&self, remote: &str, limit: u64) -> Result<Content, String> {
        let meta = self.sftp.metadata(remote).await.map_err(nice)?;
        if meta.is_dir() { return Err("This is a folder, not a file.".into()); }
        if meta.size.unwrap_or(0) > limit { return Err(TOO_BIG.into()); }
        let mut f = self.sftp.open(remote).await.map_err(nice)?;
        let mut data = Vec::new();
        // One byte more than the limit, so a file that grew since the listing is still refused.
        let r = (&mut f).take(limit + 1).read_to_end(&mut data).await.map_err(|e| format!("Couldn't read the file: {e}"));
        let _ = f.shutdown().await;
        r?;
        if data.len() as u64 > limit { return Err(TOO_BIG.into()); }
        Ok(Content { data, mtime: meta.mtime })
    }

    /// Replaces a file's contents in place (so its owner and permissions stay). With `expect` (the modified time
    /// the file had when it was opened) and no `force`, a file changed since then is refused with [`CHANGED`].
    /// Returns the file's new modified time.
    pub async fn write_file(&self, remote: &str, data: &[u8], expect: Option<u32>, force: bool) -> Result<Option<u32>, String> {
        if !force {
            if let Some(want) = expect {
                let now = self.sftp.metadata(remote).await.map_err(nice)?.mtime;
                if now != Some(want) { return Err(CHANGED.into()); }
            }
        }
        let mut dst = self.sftp.open_with_flags(remote, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE).await.map_err(nice)?;
        let r: Result<(), String> = async {
            dst.write_all(data).await.map_err(|e| format!("The save stopped: {e}"))?;
            dst.flush().await.map_err(|e| format!("The save stopped: {e}"))
        }.await;
        let _ = dst.shutdown().await;
        r?;
        Ok(self.sftp.metadata(remote).await.map_err(nice)?.mtime)
    }

    /// Whether `path` is a folder (links are followed).
    pub async fn is_dir(&self, path: &str) -> Result<bool, String> {
        Ok(self.sftp.metadata(path).await.map_err(nice)?.is_dir())
    }

    /// Lists a remote folder tree. Links aren't followed (a loop can't hang it) and are left out.
    async fn plan_remote(&self, root: &str) -> Result<Plan, String> {
        let mut plan = Plan::default();
        let mut stack = vec![(root.to_string(), String::new(), 0u32)];
        while let Some((abs, rel, depth)) = stack.pop() {
            if depth >= MAX_DEPTH { return Err("That folder is nested too deeply to download here.".into()); }
            let entries: Vec<_> = self.sftp.read_dir(abs.as_str()).await.map_err(nice)?.collect();
            for e in entries {
                let name = e.file_name();
                if name == "." || name == ".." || e.file_type().is_symlink() { continue; }
                local_component(&name)?;
                let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                let child_abs = format!("{}/{}", abs.trim_end_matches('/'), name);
                let m = e.metadata();
                if m.is_dir() {
                    plan.dirs.push(child_rel.clone());
                    stack.push((child_abs, child_rel, depth + 1));
                } else if m.is_regular() {
                    let size = m.size.unwrap_or(0);
                    plan.total += size;
                    plan.files.push((child_rel, size));
                }
            }
        }
        plan.dirs.sort();
        Ok(plan)
    }

    /// Copies a remote folder with everything in it to `local` (the new folder). When it already exists, `merge` says
    /// what to do with files that are there; without it the call stops with [`EXISTS_DIR`]. A cancelled transfer keeps
    /// the files that were already copied. Returns the bytes copied or kept.
    pub async fn download_tree(&self, remote: &str, local: &Path, merge: Option<Merge>, progress: &(dyn Fn(u64, u64) + Sync), cancel: &AtomicBool) -> Result<u64, String> {
        let plan = self.plan_remote(remote).await?;
        let exists = tokio::fs::try_exists(local).await.unwrap_or(false);
        if exists {
            if !tokio::fs::metadata(local).await.map(|m| m.is_dir()).unwrap_or(false) { return Err("A file with that name is in the way.".into()); }
            if merge.is_none() { return Err(EXISTS_DIR.into()); }
        }
        tokio::fs::create_dir_all(local).await.map_err(|e| format!("Couldn't create {}: {e}", local.display()))?;
        for d in &plan.dirs {
            let mut p = local.to_path_buf();
            for part in d.split('/') { p.push(part); }
            tokio::fs::create_dir_all(&p).await.map_err(|e| format!("Couldn't create {}: {e}", p.display()))?;
        }
        let total = plan.total;
        let mut done = 0u64;
        progress(0, total);
        for (rel, size) in &plan.files {
            if cancel.load(Ordering::Relaxed) { return Err(CANCELLED.into()); }
            let mut target = local.to_path_buf();
            for part in rel.split('/') { target.push(part); }
            if merge == Some(Merge::Skip) && tokio::fs::try_exists(&target).await.unwrap_or(false) {
                done += size;
                progress(done, total.max(done));
                continue;
            }
            let base = done;
            let cb = move |d: u64, _t: u64| progress(base + d, total.max(base + d));
            self.download(&format!("{}/{}", remote.trim_end_matches('/'), rel), &target, true, &cb, cancel).await?;
            done += size;
        }
        progress(done, total.max(done));
        Ok(done)
    }

    /// Copies a local folder with everything in it to `remote` (the new folder); same rules as [`Self::download_tree`].
    pub async fn upload_tree(&self, local: &Path, remote: &str, merge: Option<Merge>, progress: &(dyn Fn(u64, u64) + Sync), cancel: &AtomicBool) -> Result<u64, String> {
        let mut plan = Plan::default();
        let mut stack = vec![(local.to_path_buf(), String::new(), 0u32)];
        while let Some((abs, rel, depth)) = stack.pop() {
            if depth >= MAX_DEPTH { return Err("That folder is nested too deeply to upload.".into()); }
            let mut rd = tokio::fs::read_dir(&abs).await.map_err(|e| format!("Couldn't read {}: {e}", abs.display()))?;
            while let Some(e) = rd.next_entry().await.map_err(|e| format!("Couldn't read {}: {e}", abs.display()))? {
                let name = e.file_name().to_string_lossy().into_owned();
                let m = match tokio::fs::symlink_metadata(e.path()).await { Ok(m) => m, Err(_) => continue };
                if m.file_type().is_symlink() { continue; }
                let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                if m.is_dir() {
                    plan.dirs.push(child_rel.clone());
                    stack.push((e.path(), child_rel, depth + 1));
                } else if m.is_file() {
                    plan.total += m.len();
                    plan.files.push((child_rel, m.len()));
                }
            }
        }
        plan.dirs.sort();
        let exists = self.sftp.try_exists(remote).await.unwrap_or(false);
        if exists {
            if !self.is_dir(remote).await.unwrap_or(false) { return Err("A file with that name is in the way.".into()); }
            if merge.is_none() { return Err(EXISTS_DIR.into()); }
        } else {
            self.sftp.create_dir(remote).await.map_err(nice)?;
        }
        for d in &plan.dirs {
            let path = format!("{}/{}", remote.trim_end_matches('/'), d);
            if !self.sftp.try_exists(path.as_str()).await.unwrap_or(false) { self.sftp.create_dir(path.as_str()).await.map_err(nice)?; }
        }
        let total = plan.total;
        let mut done = 0u64;
        progress(0, total);
        for (rel, size) in &plan.files {
            if cancel.load(Ordering::Relaxed) { return Err(CANCELLED.into()); }
            let mut src = local.to_path_buf();
            for part in rel.split('/') { src.push(part); }
            let dest = format!("{}/{}", remote.trim_end_matches('/'), rel);
            if merge == Some(Merge::Skip) && self.sftp.try_exists(dest.as_str()).await.unwrap_or(false) {
                done += size;
                progress(done, total.max(done));
                continue;
            }
            let base = done;
            let cb = move |d: u64, _t: u64| progress(base + d, total.max(base + d));
            self.upload(&src, &dest, true, &cb, cancel).await?;
            done += size;
        }
        progress(done, total.max(done));
        Ok(done)
    }

    /// Moves `from` to `to`. When something is already at `to`, `on` decides: fail with [`EXISTS`], replace it (the old
    /// one goes to the Trash, or is deleted when `use_trash` is off) or keep both (the moved item gets a free name).
    /// Returns where the item ended up.
    pub async fn move_item(&self, from: &str, to: &str, on: OnConflict, use_trash: bool) -> Result<String, String> {
        let from = from.trim_end_matches('/');
        let to = to.trim_end_matches('/');
        if to == from || to.starts_with(&format!("{from}/")) { return Err("A folder can't be moved into itself.".into()); }
        let mut target = to.to_string();
        if self.sftp.try_exists(to).await.unwrap_or(false) {
            match on {
                OnConflict::Fail => return Err(EXISTS.into()),
                OnConflict::Replace => {
                    if use_trash { self.trash(to).await? } else { self.remove(to).await? }
                }
                OnConflict::KeepBoth => {
                    let (dir, name) = to.rsplit_once('/').unwrap_or(("", to));
                    let mut n = 2;
                    loop {
                        let cand = format!("{dir}/{}", numbered(name, n));
                        if !self.sftp.try_exists(cand.as_str()).await.unwrap_or(false) { target = cand; break; }
                        n += 1;
                        if n > 1000 { return Err("Couldn't find a free name for it.".into()); }
                    }
                }
            }
        }
        self.sftp.rename(from, target.as_str()).await.map_err(nice)?;
        Ok(target)
    }

    /// Copies a remote file to `local`, reporting `(done, total)` bytes. A half-written file never takes the
    /// target's place: it is written beside it and renamed at the end.
    pub async fn download(&self, remote: &str, local: &Path, overwrite: bool, progress: &(dyn Fn(u64, u64) + Sync), cancel: &AtomicBool) -> Result<u64, String> {
        let meta = self.sftp.metadata(remote).await.map_err(nice)?;
        if meta.is_dir() { return Err("Downloading a folder isn't supported yet. Open it and select the files instead.".into()); }
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
        if meta.is_dir() { return Err("Uploading a folder isn't supported yet. Select the files inside it instead.".into()); }
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

    /// A file for the viewer: the bytes as base64 (an image is shown from them, text is decoded in the web view).
    #[derive(Serialize)]
    pub struct FileData { data: String, mtime: Option<u32> }

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

    #[tauri::command]
    pub async fn sftp_trash(id: u32, path: String, state: State<'_, SftpState>) -> Result<(), String> {
        state.session(id)?.trash(&path).await
    }

    #[tauri::command]
    pub async fn sftp_trash_list(id: u32, state: State<'_, SftpState>) -> Result<Vec<TrashItem>, String> {
        state.session(id)?.list_trash().await
    }

    #[tauri::command]
    pub async fn sftp_trash_restore(id: u32, item: String, state: State<'_, SftpState>) -> Result<(), String> {
        state.session(id)?.restore(&item).await
    }

    #[tauri::command]
    pub async fn sftp_trash_delete(id: u32, item: String, state: State<'_, SftpState>) -> Result<(), String> {
        state.session(id)?.purge(&item).await
    }

    #[tauri::command]
    pub async fn sftp_trash_empty(id: u32, state: State<'_, SftpState>) -> Result<(), String> {
        state.session(id)?.empty_trash().await
    }

    #[tauri::command]
    pub async fn sftp_read(id: u32, path: String, limit: u64, state: State<'_, SftpState>) -> Result<FileData, String> {
        use base64::Engine as _;
        let c = state.session(id)?.read_file(&path, limit).await?;
        Ok(FileData { data: base64::engine::general_purpose::STANDARD.encode(&c.data), mtime: c.mtime })
    }

    /// Saves text the viewer edited; `expect` is the modified time it was opened with (see `Sftp::write_file`).
    #[tauri::command]
    pub async fn sftp_write(id: u32, path: String, text: String, expect: Option<u32>, force: bool,
                            state: State<'_, SftpState>) -> Result<Option<u32>, String> {
        state.session(id)?.write_file(&path, text.as_bytes(), expect, force).await
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

    /// Downloads a file, or a whole folder (`merge`: `skip` / `replace` when the folder already exists here).
    #[tauri::command]
    pub async fn sftp_download(id: u32, transfer_id: u32, remote: String, local: String, overwrite: bool, merge: Option<String>, app: AppHandle,
                               state: State<'_, SftpState>) -> Result<u64, String> {
        let s = state.session(id)?;
        let merge = merge.as_deref().and_then(Merge::parse);
        let dir = s.is_dir(&remote).await?;
        transfer(transfer_id, &app, &state, |cancel, progress| async move {
            if dir { s.download_tree(&remote, Path::new(&local), merge, &*progress, &cancel).await }
            else { s.download(&remote, Path::new(&local), overwrite, &*progress, &cancel).await }
        }).await
    }

    /// Uploads a file, or a whole folder (`merge`: `skip` / `replace` when the folder already exists on the server).
    #[tauri::command]
    pub async fn sftp_upload(id: u32, transfer_id: u32, local: String, remote: String, overwrite: bool, merge: Option<String>, app: AppHandle,
                             state: State<'_, SftpState>) -> Result<u64, String> {
        let s = state.session(id)?;
        let merge = merge.as_deref().and_then(Merge::parse);
        let dir = tokio::fs::metadata(&local).await.map(|m| m.is_dir()).unwrap_or(false);
        transfer(transfer_id, &app, &state, |cancel, progress| async move {
            if dir { s.upload_tree(Path::new(&local), &remote, merge, &*progress, &cancel).await }
            else { s.upload(Path::new(&local), &remote, overwrite, &*progress, &cancel).await }
        }).await
    }

    /// Moves an item; `on_conflict`: `fail`, `replace` or `keep_both`. Returns the path it ended up at.
    #[tauri::command]
    pub async fn sftp_move(id: u32, from: String, to: String, on_conflict: String, use_trash: bool, state: State<'_, SftpState>) -> Result<String, String> {
        let on = OnConflict::parse(&on_conflict).ok_or("Unknown conflict choice.")?;
        state.session(id)?.move_item(&from, &to, on, use_trash).await
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
        // A counter as well as the clock: two tests starting in the same clock tick must not share a folder.
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let c = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("notiq-sftp-{tag}-{}-{n}-{c}", std::process::id()));
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
        // A folder's own size depends on the filesystem (0 on Windows, 4096 on Linux), so only files' sizes are checked.
        let names: Vec<_> = l.entries.iter().map(|e| (e.name.as_str(), e.kind)).collect();
        assert_eq!(names, vec![("zdir", "dir"), ("A.txt", "file"), ("b.txt", "file")]);
        assert_eq!(l.entries.iter().filter(|e| e.kind == "file").map(|e| e.size).collect::<Vec<_>>(), vec![1, 2]);
        assert!(s.list("/nope").await.is_err());
    }

    #[tokio::test]
    async fn reads_a_file_for_the_viewer_and_refuses_a_big_one() {
        let f = start(true).await;
        std::fs::write(f.root.join("note.txt"), "héllo").unwrap();
        std::fs::write(f.root.join("big.bin"), vec![7u8; 5000]).unwrap();
        let s = session(&f).await;
        let c = s.read_file("/note.txt", 1000).await.unwrap();
        assert_eq!(String::from_utf8(c.data).unwrap(), "héllo");
        assert_eq!(s.read_file("/big.bin", 4999).await.unwrap_err(), TOO_BIG);
        assert_eq!(s.read_file("/big.bin", 5000).await.unwrap().data.len(), 5000);
        assert!(s.read_file("/nope", 10).await.is_err());
    }

    #[tokio::test]
    async fn saves_an_edit_in_place_and_notices_a_change_made_elsewhere() {
        let f = start(true).await;
        let file = f.root.join("conf.txt");
        std::fs::write(&file, "one two three").unwrap();
        let s = session(&f).await;
        let opened = s.read_file("/conf.txt", 1000).await.unwrap();
        // A shorter text replaces the longer one completely.
        s.write_file("/conf.txt", b"new", opened.mtime, false).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        // The file was changed behind the editor's back: refused, unless forced.
        let stale = Some(opened.mtime.unwrap_or(0).wrapping_sub(100));
        assert_eq!(s.write_file("/conf.txt", b"mine", stale, false).await.unwrap_err(), CHANGED);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        s.write_file("/conf.txt", b"mine", stale, true).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
    }

    #[test]
    fn trash_info_helpers_round_trip() {
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00");
        assert_eq!(iso_from_unix(1_700_000_000), "2023-11-14T22:13:20");
        for t in [0u64, 86_399, 1_700_000_000, 4_102_444_800] { assert_eq!(unix_from_iso(&iso_from_unix(t)), Some(t)); }
        assert_eq!(unix_from_iso("garbage"), None);
        assert_eq!(pct_encode("/home/a b/\u{e9}.txt"), "/home/a%20b/%C3%A9.txt");
        assert_eq!(pct_decode("/home/a%20b/%C3%A9.txt"), "/home/a b/\u{e9}.txt");
        assert_eq!(pct_decode("100%"), "100%");
        let (p, t) = parse_trashinfo("[Trash Info]\nPath=/home/me/my%20file.txt\nDeletionDate=2023-11-14T22:13:20\n").unwrap();
        assert_eq!((p.as_str(), t), ("/home/me/my file.txt", Some(1_700_000_000)));
        assert!(parse_trashinfo("nothing here").is_none());
    }

    #[tokio::test]
    async fn trash_keeps_deleted_items_and_can_restore_or_purge_them() {
        let f = start(true).await;
        std::fs::write(f.root.join("a.txt"), "one").unwrap();
        std::fs::create_dir(f.root.join("dir")).unwrap();
        std::fs::write(f.root.join("dir/inner.txt"), "x").unwrap();
        let s = session(&f).await;
        s.trash("/a.txt").await.unwrap();
        s.trash("/dir").await.unwrap();
        assert!(!f.root.join("a.txt").exists() && !f.root.join("dir").exists());
        let items = s.list_trash().await.unwrap();
        assert_eq!(items.len(), 2);
        let a = items.iter().find(|i| i.id == "a.txt").unwrap();
        assert_eq!((a.original.as_str(), a.kind, a.size), ("/a.txt", "file", 3));
        assert!(a.deleted.unwrap() > 1_700_000_000);
        assert_eq!(items.iter().find(|i| i.id == "dir").unwrap().kind, "dir");
        // The same name again gets its own slot instead of overwriting.
        std::fs::write(f.root.join("a.txt"), "two").unwrap();
        s.trash("/a.txt").await.unwrap();
        assert_eq!(s.list_trash().await.unwrap().len(), 3);
        // Restore puts it back; a taken place is refused.
        s.restore("dir").await.unwrap();
        assert!(f.root.join("dir/inner.txt").exists());
        std::fs::write(f.root.join("a.txt"), "three").unwrap();
        assert_eq!(s.restore("a.txt").await.unwrap_err(), EXISTS);
        // Deleting for good and emptying.
        s.purge("a.txt").await.unwrap();
        assert_eq!(s.list_trash().await.unwrap().len(), 1);
        s.empty_trash().await.unwrap();
        assert!(s.list_trash().await.unwrap().is_empty());
        // Odd ids and the home folder are refused.
        assert!(s.restore("../x").await.is_err());
        assert!(s.trash("/").await.is_err());
    }

    #[test]
    fn numbered_names_and_unsafe_local_names() {
        assert_eq!(numbered("report.pdf", 2), "report (2).pdf");
        assert_eq!(numbered("archive.tar.gz", 3), "archive.tar (3).gz");
        assert_eq!(numbered("Makefile", 2), "Makefile (2)");
        assert_eq!(numbered(".bashrc", 2), ".bashrc (2)");
        assert!(local_component("ok name.txt").is_ok());
        assert!(local_component("..").is_err());
        assert!(local_component("a/b").is_err());
        assert!(local_component("").is_err());
        if cfg!(windows) { assert!(local_component("a:b").is_err()); assert!(local_component("a\\b").is_err()); }
    }

    /// A small tree: `top.txt`, `sub/inner.txt`, `sub/deep/leaf.bin` and an empty `empty/`.
    fn make_tree(root: &Path) {
        std::fs::create_dir_all(root.join("sub/deep")).unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::fs::write(root.join("top.txt"), "top").unwrap();
        std::fs::write(root.join("sub/inner.txt"), "inner!").unwrap();
        std::fs::write(root.join("sub/deep/leaf.bin"), vec![9u8; 3000]).unwrap();
    }

    #[tokio::test]
    async fn uploads_and_downloads_a_whole_folder_and_asks_before_merging() {
        let f = start(true).await;
        let s = session(&f).await;
        let local = temp_root("tree-src");
        make_tree(&local);
        let seen = std::sync::Mutex::new((0u64, 0u64));
        let rec = |d: u64, t: u64| *seen.lock().unwrap() = (d, t);
        let cancel = AtomicBool::new(false);

        // Up: the folder arrives with its structure, empty folders included, and the progress reaches the total.
        let bytes = s.upload_tree(&local, "/proj", None, &rec, &cancel).await.unwrap();
        assert_eq!(bytes, 3 + 6 + 3000);
        assert_eq!(*seen.lock().unwrap(), (3009, 3009));
        assert_eq!(std::fs::read_to_string(f.root.join("proj/sub/inner.txt")).unwrap(), "inner!");
        assert!(f.root.join("proj/empty").is_dir());
        assert_eq!(std::fs::read(f.root.join("proj/sub/deep/leaf.bin")).unwrap().len(), 3000);

        // The folder is there now: asks, unless told how to merge.
        assert_eq!(s.upload_tree(&local, "/proj", None, &rec, &cancel).await.unwrap_err(), EXISTS_DIR);
        std::fs::write(f.root.join("proj/top.txt"), "changed on the server").unwrap();
        s.upload_tree(&local, "/proj", Some(Merge::Skip), &rec, &cancel).await.unwrap();
        assert_eq!(std::fs::read_to_string(f.root.join("proj/top.txt")).unwrap(), "changed on the server");
        s.upload_tree(&local, "/proj", Some(Merge::Replace), &rec, &cancel).await.unwrap();
        assert_eq!(std::fs::read_to_string(f.root.join("proj/top.txt")).unwrap(), "top");

        // Down: the same, into a new local folder.
        let dest = temp_root("tree-dst").join("proj");
        assert_eq!(s.download_tree("/proj", &dest, None, &rec, &cancel).await.unwrap(), 3009);
        assert_eq!(std::fs::read_to_string(dest.join("sub/inner.txt")).unwrap(), "inner!");
        assert!(dest.join("empty").is_dir());
        assert_eq!(s.download_tree("/proj", &dest, None, &rec, &cancel).await.unwrap_err(), EXISTS_DIR);
        std::fs::write(dest.join("top.txt"), "mine").unwrap();
        s.download_tree("/proj", &dest, Some(Merge::Skip), &rec, &cancel).await.unwrap();
        assert_eq!(std::fs::read_to_string(dest.join("top.txt")).unwrap(), "mine");
        s.download_tree("/proj", &dest, Some(Merge::Replace), &rec, &cancel).await.unwrap();
        assert_eq!(std::fs::read_to_string(dest.join("top.txt")).unwrap(), "top");
        // No half-written leftovers.
        let leftovers = walk_names(&dest).into_iter().filter(|n| n.ends_with(".notiq-part")).count();
        assert_eq!(leftovers, 0);
    }

    fn walk_names(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            out.push(e.file_name().to_string_lossy().into_owned());
            if e.path().is_dir() { out.extend(walk_names(&e.path())); }
        }
        out
    }

    #[tokio::test]
    async fn a_cancelled_folder_transfer_stops() {
        let f = start(true).await;
        let s = session(&f).await;
        let local = temp_root("tree-cancel");
        make_tree(&local);
        let cancel = AtomicBool::new(true);
        assert_eq!(s.upload_tree(&local, "/proj", None, &|_, _| {}, &cancel).await.unwrap_err(), CANCELLED);
        assert!(!f.root.join("proj/sub/inner.txt").exists());
    }

    #[tokio::test]
    async fn moving_handles_a_taken_name_by_failing_replacing_or_keeping_both() {
        let f = start(true).await;
        std::fs::write(f.root.join("a.txt"), "new").unwrap();
        std::fs::create_dir(f.root.join("d")).unwrap();
        std::fs::write(f.root.join("d/a.txt"), "old").unwrap();
        let s = session(&f).await;
        // Free name: a plain move.
        assert_eq!(s.move_item("/a.txt", "/b.txt", OnConflict::Fail, true).await.unwrap(), "/b.txt");
        std::fs::rename(f.root.join("b.txt"), f.root.join("a.txt")).unwrap();
        // Taken: refused unless a choice was made.
        assert_eq!(s.move_item("/a.txt", "/d/a.txt", OnConflict::Fail, true).await.unwrap_err(), EXISTS);
        assert!(f.root.join("a.txt").exists());
        // Keep both: the moved one gets a free name.
        assert_eq!(s.move_item("/a.txt", "/d/a.txt", OnConflict::KeepBoth, true).await.unwrap(), "/d/a (2).txt");
        assert_eq!(std::fs::read_to_string(f.root.join("d/a (2).txt")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(f.root.join("d/a.txt")).unwrap(), "old");
        // Replace: the old one goes to the Trash.
        std::fs::write(f.root.join("a.txt"), "newest").unwrap();
        assert_eq!(s.move_item("/a.txt", "/d/a.txt", OnConflict::Replace, true).await.unwrap(), "/d/a.txt");
        assert_eq!(std::fs::read_to_string(f.root.join("d/a.txt")).unwrap(), "newest");
        let trash = s.list_trash().await.unwrap();
        assert!(trash.iter().any(|t| t.original == "/d/a.txt"));
        // Replace without the Trash deletes the old one.
        std::fs::write(f.root.join("a.txt"), "last").unwrap();
        s.move_item("/a.txt", "/d/a.txt", OnConflict::Replace, false).await.unwrap();
        assert_eq!(std::fs::read_to_string(f.root.join("d/a.txt")).unwrap(), "last");
        assert_eq!(s.list_trash().await.unwrap().len(), trash.len());
        // A folder can't go into itself.
        assert!(s.move_item("/d", "/d/inside", OnConflict::Fail, true).await.is_err());
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
