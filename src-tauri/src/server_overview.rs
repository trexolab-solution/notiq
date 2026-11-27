//! Server overview for a saved SSH entry: CPU, memory, swap, disks and the basics (OS, kernel, host name, uptime).
//!
//! It signs in exactly like the file manager does ([`crate::sftp_client::sign_in`]: same vault entry, same host-key
//! rules, the UI's approval of an untrusted key, a changed key always refused), then runs one fixed, read-only
//! command ([`COMMAND`]) on every poll. Nothing from the entry or the user is ever put into that command. What the
//! server prints is untrusted: output is capped, the run has a time limit, and the parser below reads it
//! defensively (numbers checked, strings cleaned and shortened, lists capped). Linux only: another system is
//! reported as not supported rather than shown with wrong numbers.
//!
//! [`Monitor`] holds one connection and is tested against an in-process server; the Tauri commands at the bottom
//! keep monitors by the ids the web view picked, tied to the window that opened them.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;

use crate::ssh_client::{Conn, Connect, KnownHosts, UnknownHost};

/// The one command the overview runs, always exactly this. Read-only: it reads `/proc`, `/etc/os-release` and
/// `uname`, and runs `df -P -k` (under `timeout` where there is one, so a hung network mount can't keep it running).
/// Every read is size-limited on the server too. Run with `sh` so the user's login shell doesn't matter.
pub const COMMAND: &str = "sh -c 'export LC_ALL=C
echo @@uname; uname -s; uname -r; uname -m
echo @@host; cat /proc/sys/kernel/hostname 2>/dev/null
echo @@osrel; head -c 4096 /etc/os-release 2>/dev/null
echo @@uptime; head -c 256 /proc/uptime 2>/dev/null
echo @@load; head -c 256 /proc/loadavg 2>/dev/null
echo @@stat; grep ^cpu /proc/stat 2>/dev/null | head -n 1100
echo @@cpuinfo; grep -m 1 \"model name\" /proc/cpuinfo 2>/dev/null
echo @@mem; head -c 16384 /proc/meminfo 2>/dev/null
echo @@mounts; head -c 65536 /proc/mounts 2>/dev/null
echo @@df; if command -v timeout >/dev/null 2>&1; then timeout 5 df -P -k 2>/dev/null; else df -P -k 2>/dev/null; fi | head -n 400
echo @@end'";

/// Most bytes of output read from one run; more than that ends the run with an error.
const MAX_OUTPUT: usize = 256 * 1024;
/// Longest one run may take.
const RUN_TIMEOUT: Duration = Duration::from_secs(12);
/// Most filesystems shown; the rest are counted in `disks_more`.
const MAX_DISKS: usize = 16;
/// Most mount lines / df lines looked at.
const MAX_LINES: usize = 4096;

/// What a poll says while another poll of the same monitor is still running.
pub const BUSY: &str = "busy";

// ── what the UI gets ─────────────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    /// Page cache and reclaimable memory (part of `available`).
    pub cached: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Swap { pub total: u64, pub used: u64 }

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub mount: String,
    pub device: String,
    /// Empty when the server didn't say.
    pub fs_type: String,
    pub total: u64,
    pub used: u64,
    pub available: u64,
}

/// One reading of the server. Every field the server didn't give (or gave in a form that doesn't make sense) is empty.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// False for anything but Linux; only `system` (and `hostname`) are then filled in.
    pub supported: bool,
    /// What `uname -s` said, e.g. `Linux`.
    pub system: String,
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub kernel: Option<String>,
    pub arch: Option<String>,
    pub cpu_model: Option<String>,
    pub uptime_secs: Option<u64>,
    pub cores: Option<u32>,
    /// Busy share of all CPUs since the previous poll (none on the first one).
    pub cpu_percent: Option<f64>,
    pub load: Option<[f64; 3]>,
    pub memory: Option<Memory>,
    pub swap: Option<Swap>,
    pub disks: Vec<Disk>,
    /// Real filesystems left out because there were more than fit.
    pub disks_more: u32,
}

// ── reading the output ───────────────────────────────────────────────────────

/// Text that is safe and short: no control characters or text-direction overrides, trimmed, at most `max` characters.
fn clean(s: &str, max: usize) -> String {
    let bidi = |c: char| matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}');
    s.chars().filter(|c| !c.is_control() && !bidi(*c)).take(max).collect::<String>().trim().to_string()
}

fn clean_opt(s: &str, max: usize) -> Option<String> { Some(clean(s, max)).filter(|t| !t.is_empty()) }

/// The output split at its `@@name` marker lines; only the first section of each name counts.
fn sections(out: &str) -> HashMap<&str, Vec<&str>> {
    let mut map: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut cur: Option<&str> = None;
    for line in out.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(name) = line.strip_prefix("@@") {
            let name = name.trim();
            cur = if map.contains_key(name) { None } else { map.insert(name, Vec::new()); Some(name) };
            continue;
        }
        if let Some(n) = cur { if let Some(v) = map.get_mut(n) { if v.len() < MAX_LINES { v.push(line); } } }
    }
    map
}

/// A number that makes sense for a counter or size: finite, not negative, below `max`.
fn num(s: &str, max: f64) -> Option<f64> {
    let v: f64 = s.trim().parse().ok()?;
    (v.is_finite() && v >= 0.0 && v <= max).then_some(v)
}

/// Totals of one `cpu` line of /proc/stat.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CpuSample { pub total: u64, pub idle: u64 }

fn parse_cpu_line(line: &str) -> Option<CpuSample> {
    let mut it = line.split_whitespace();
    if it.next()? != "cpu" { return None; }
    let vals: Vec<u64> = it.take(8).map(|v| v.parse::<u64>()).collect::<Result<_, _>>().ok()?;
    if vals.len() < 4 { return None; }
    let total = vals.iter().try_fold(0u64, |a, v| a.checked_add(*v))?;
    let idle = vals[3].checked_add(*vals.get(4).unwrap_or(&0))?;
    (idle <= total).then_some(CpuSample { total, idle })
}

/// Busy percentage between two samples; none when the counters didn't move forward.
pub fn cpu_percent(prev: &CpuSample, now: &CpuSample) -> Option<f64> {
    let dt = now.total.checked_sub(prev.total)?;
    let di = now.idle.checked_sub(prev.idle)?;
    if dt == 0 || di > dt { return None; }
    Some(((dt - di) as f64 / dt as f64 * 100.0).clamp(0.0, 100.0))
}

/// `\040`-style escapes of /proc/mounts.
fn unescape_mount(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 4 <= b.len() && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
            let v = b[i + 1..i + 4].iter().fold(0u32, |a, c| a * 8 + u32::from(c - b'0'));
            if let Ok(v) = u8::try_from(v) { out.push(v); i += 4; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Filesystem types that hold no files of their own (kernel views, memory, container layers, snaps).
const PSEUDO_FS: &[&str] = &[
    "tmpfs", "devtmpfs", "proc", "sysfs", "cgroup", "cgroup2", "devpts", "mqueue", "debugfs", "tracefs", "securityfs",
    "pstore", "bpf", "configfs", "fusectl", "hugetlbfs", "efivarfs", "autofs", "binfmt_misc", "rpc_pipefs", "nsfs",
    "ramfs", "squashfs", "overlay", "aufs", "selinuxfs", "nfsd", "fuse.lxcfs", "fuse.snapfuse", "fuse.portal",
    "fuse.gvfsd-fuse", "fuse.gvfs-fuse-daemon", "none",
];
/// df's "filesystem" names that mean the same when /proc/mounts can't be read.
const PSEUDO_DEV: &[&str] = &["tmpfs", "devtmpfs", "udev", "none", "overlay", "shm", "proc", "sysfs", "cgroup", "cgroup2"];

/// One df -P line: device, sizes in KiB, mount point. Names may hold spaces: the numbers are found from the `NN%` column.
fn parse_df_line(line: &str) -> Option<(String, u64, u64, u64, String)> {
    let t: Vec<&str> = line.split_whitespace().collect();
    let cap = (4..t.len()).find(|&i| {
        t[i].strip_suffix('%').is_some_and(|p| p == "-" || p.parse::<u32>().is_ok())
            && t[i - 3..i].iter().all(|n| n.parse::<u64>().is_ok())
    })?;
    if cap + 1 >= t.len() { return None; }
    let kib = |s: &str| s.parse::<u64>().ok().map(|v| v.saturating_mul(1024));
    let (total, used, avail) = (kib(t[cap - 3])?, kib(t[cap - 2])?, kib(t[cap - 1])?);
    Some((t[..cap - 3].join(" "), total, used, avail, t[cap + 1..].join(" ")))
}

fn parse_disks(df: &[&str], mounts: &[&str]) -> (Vec<Disk>, u32) {
    let mut types: HashMap<String, String> = HashMap::new();
    for line in mounts.iter().take(MAX_LINES) {
        let mut it = line.split_whitespace();
        if let (Some(_), Some(mp), Some(fs)) = (it.next(), it.next(), it.next()) {
            types.insert(unescape_mount(mp), fs.to_string());
        }
    }
    let mut all: Vec<Disk> = Vec::new();
    let mut root: Option<Disk> = None;
    let mut seen: HashSet<String> = HashSet::new();
    for line in df.iter().take(MAX_LINES) {
        if line.starts_with("Filesystem") { continue; }
        let Some((dev, total, used, avail, mount)) = parse_df_line(line) else { continue };
        if total == 0 || !mount.starts_with('/') { continue; }
        let fs = types.get(&mount).cloned().unwrap_or_default();
        let disk = Disk {
            mount: clean(&mount, 256), device: clean(&dev, 128), fs_type: clean(&fs, 32),
            total, used: used.min(total), available: avail.min(total),
        };
        if mount == "/" && root.is_none() { root = Some(disk.clone()); }
        let pseudo = if fs.is_empty() { PSEUDO_DEV.contains(&dev.as_str()) } else { PSEUDO_FS.contains(&fs.as_str()) };
        if pseudo || dev.starts_with("/dev/loop") { continue; }
        // Bind mounts and btrfs subvolumes show one filesystem many times: keep the first.
        if !seen.insert(dev.clone()) { continue; }
        all.push(disk);
    }
    // In a container / is an overlay: show it rather than nothing.
    if all.is_empty() { if let Some(r) = root { all.push(r); } }
    // The root filesystem first, the rest as df listed them.
    if let Some(i) = all.iter().position(|d| d.mount == "/") { let r = all.remove(i); all.insert(0, r); }
    let more = all.len().saturating_sub(MAX_DISKS) as u32;
    all.truncate(MAX_DISKS);
    (all, more)
}

fn parse_memory(lines: &[&str]) -> (Option<Memory>, Option<Swap>) {
    let mut kv: HashMap<&str, u64> = HashMap::new();
    for line in lines {
        let Some((k, rest)) = line.split_once(':') else { continue };
        let Some(v) = rest.split_whitespace().next().and_then(|v| v.parse::<u64>().ok()) else { continue };
        kv.entry(k.trim()).or_insert(v.saturating_mul(1024));
    }
    let g = |k: &str| kv.get(k).copied();
    let mem = g("MemTotal").filter(|t| *t > 0).map(|total| {
        let cached = g("Buffers").unwrap_or(0).saturating_add(g("Cached").unwrap_or(0)).saturating_add(g("SReclaimable").unwrap_or(0));
        let available = g("MemAvailable").unwrap_or_else(|| g("MemFree").unwrap_or(0).saturating_add(cached)).min(total);
        Memory { total, used: total - available, available, cached: cached.min(total) }
    });
    let swap = g("SwapTotal").map(|total| Swap { total, used: total - g("SwapFree").unwrap_or(total).min(total) });
    (mem, swap)
}

/// `PRETTY_NAME` (or `NAME VERSION`) of /etc/os-release.
fn parse_os_release(lines: &[&str]) -> Option<String> {
    let get = |key: &str| lines.iter().find_map(|l| l.strip_prefix(key).and_then(|v| v.strip_prefix('=')))
        .map(|v| v.trim().trim_matches(['"', '\'']).to_string()).filter(|v| !v.is_empty());
    let name = get("PRETTY_NAME").or_else(|| get("NAME").map(|n| match get("VERSION") { Some(v) => format!("{n} {v}"), None => n }))?;
    clean_opt(&name, 120)
}

/// Reads one run's output. The CPU percentage needs the previous sample, so the sample comes back beside it.
pub fn parse(out: &str) -> (Overview, Option<CpuSample>) {
    let s = sections(out);
    let sec = |name: &str| s.get(name).map(Vec::as_slice).unwrap_or(&[]);
    let uname = sec("uname");
    let first = |v: &[&str]| v.iter().map(|l| l.trim()).find(|l| !l.is_empty()).unwrap_or("").to_string();
    let mut ov = Overview {
        system: clean(uname.first().copied().unwrap_or(""), 40),
        hostname: clean_opt(&first(sec("host")), 253),
        ..Default::default()
    };
    if ov.system != "Linux" { return (ov, None); }
    ov.supported = true;
    ov.kernel = uname.get(1).and_then(|k| clean_opt(k, 120));
    ov.arch = uname.get(2).and_then(|a| clean_opt(a, 40));
    ov.os = parse_os_release(sec("osrel"));
    ov.uptime_secs = sec("uptime").first().and_then(|l| l.split_whitespace().next()).and_then(|v| num(v, 1e10)).map(|v| v as u64);
    ov.load = sec("load").first().and_then(|l| {
        let v: Vec<f64> = l.split_whitespace().take(3).filter_map(|x| num(x, 1e6)).collect();
        (v.len() == 3).then(|| [v[0], v[1], v[2]])
    });
    let stat = sec("stat");
    // `cpu0`, `cpu1`, … (the `cpu` line without a number is the total).
    let cores = stat.iter().filter(|l| l.strip_prefix("cpu").and_then(|r| r.split_whitespace().next()).is_some_and(|n| n.parse::<u32>().is_ok())
        && l.as_bytes().get(3).is_some_and(u8::is_ascii_digit)).count();
    ov.cores = (cores > 0).then_some(cores.min(100_000) as u32);
    let sample = stat.iter().find_map(|l| parse_cpu_line(l));
    ov.cpu_model = sec("cpuinfo").first().and_then(|l| l.split_once(':')).and_then(|(_, v)| clean_opt(v, 120));
    (ov.memory, ov.swap) = parse_memory(sec("mem"));
    (ov.disks, ov.disks_more) = parse_disks(sec("df"), sec("mounts"));
    (ov, sample)
}

// ── one connection ───────────────────────────────────────────────────────────

/// Runs [`COMMAND`] on `conn` and returns its standard output (standard error is dropped).
async fn run_fixed(conn: &Conn, limit: Duration) -> Result<String, String> {
    let run = async {
        let mut ch = conn.channel_open_session().await.map_err(|e| format!("Couldn't open a session: {e}"))?;
        ch.exec(true, COMMAND).await.map_err(|_| NO_EXEC.to_string())?;
        let mut out: Vec<u8> = Vec::new();
        loop {
            match ch.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    if out.len() + data.len() > MAX_OUTPUT {
                        let _ = ch.close().await;
                        return Err("The server sent far more than expected, so its details aren't shown.".to_string());
                    }
                    out.extend_from_slice(&data);
                }
                Some(ChannelMsg::Failure) => return Err(NO_EXEC.to_string()),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    };
    tokio::time::timeout(limit, run).await.map_err(|_| "The server took too long to answer.".to_string())?
}

const NO_EXEC: &str = "This server doesn't allow running commands, so its details can't be read.";

/// One signed-in connection that the overview polls. Dropping it closes the connection.
pub struct Monitor {
    conn: Conn,
    _jump: Option<Conn>,
    prev: std::sync::Mutex<Option<CpuSample>>,
    /// Held while a poll runs: polls never overlap.
    running: tokio::sync::Mutex<()>,
    limit: Duration,
}

impl Monitor {
    /// Signs in for `c`, trusting `approved` only if that is exactly what an untrusted host presents.
    pub async fn open(c: Connect, known: KnownHosts, approved: Option<UnknownHost>) -> Result<Monitor, String> {
        let (conn, jump) = crate::sftp_client::sign_in(&c, &known, approved).await?;
        Ok(Monitor { conn, _jump: jump, prev: Default::default(), running: Default::default(), limit: RUN_TIMEOUT })
    }

    /// One reading. Fails with [`BUSY`] while another one is running.
    pub async fn poll(&self) -> Result<Overview, String> {
        let _one = self.running.try_lock().map_err(|_| BUSY.to_string())?;
        let out = run_fixed(&self.conn, self.limit).await?;
        let (mut ov, sample) = parse(&out);
        let mut prev = self.prev.lock().unwrap_or_else(|e| e.into_inner());
        ov.cpu_percent = match (prev.as_ref(), sample.as_ref()) { (Some(p), Some(n)) => cpu_percent(p, n), _ => None };
        *prev = sample;
        Ok(ov)
    }
}

// ── the commands ─────────────────────────────────────────────────────────────

mod commands {
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use tauri::{AppHandle, Manager, State, Webview};

    use super::*;

    /// A monitor nobody polled for this long is closed (a window that went away without saying so).
    const IDLE: Duration = Duration::from_secs(120);
    const CLOSED: &str = "The connection to the server was closed. Connect again to continue.";

    struct Slot { window: String, monitor: Arc<Monitor>, used: Instant }

    /// Open monitors by the ids the web view picked, each tied to the window that opened it.
    #[derive(Default)]
    pub struct OverviewState { slots: Mutex<HashMap<u32, Slot>> }

    impl OverviewState {
        fn slots(&self) -> std::sync::MutexGuard<'_, HashMap<u32, Slot>> {
            let mut s = self.slots.lock().unwrap_or_else(|e| e.into_inner());
            s.retain(|_, slot| slot.used.elapsed() < IDLE);
            s
        }
    }

    #[tauri::command]
    pub async fn server_overview_open(id: u32, path: String, auth: String, trust: Option<UnknownHost>, webview: Webview, app: AppHandle,
                                      state: State<'_, OverviewState>, vault: State<'_, crate::vault::VaultState>) -> Result<(), String> {
        if state.slots().contains_key(&id) { return Err("That connection id is already in use.".into()); }
        let session = crate::ssh_connect::load_session(&vault, &path, crate::ssh_connect::Auth::parse(&auth)?)?;
        let connect = Connect::from_session(session)?;
        let known = KnownHosts::new(app.path().app_data_dir().map_err(|e| e.to_string())?.join("ssh_known_hosts.json"));
        let monitor = Arc::new(Monitor::open(connect, known, trust).await?);
        // The vault may have locked while signing in: then nothing is kept.
        if !vault.is_unlocked() { return Err("The vault is locked.".into()); }
        let mut slots = state.slots();
        if slots.contains_key(&id) { return Err("That connection id is already in use.".into()); }
        slots.insert(id, Slot { window: webview.label().to_string(), monitor, used: Instant::now() });
        Ok(())
    }

    #[tauri::command]
    pub async fn server_overview_poll(id: u32, webview: Webview, state: State<'_, OverviewState>,
                                      vault: State<'_, crate::vault::VaultState>) -> Result<Overview, String> {
        // A locked vault closes every connection the overview holds.
        if !vault.is_unlocked() { state.slots().clear(); return Err("The vault is locked.".into()); }
        let monitor = {
            let mut slots = state.slots();
            let slot = slots.get_mut(&id).filter(|s| s.window == webview.label()).ok_or(CLOSED)?;
            slot.used = Instant::now();
            slot.monitor.clone()
        };
        monitor.poll().await
    }

    #[tauri::command]
    pub fn server_overview_close(id: u32, webview: Webview, state: State<'_, OverviewState>) {
        let mut slots = state.slots();
        if slots.get(&id).is_some_and(|s| s.window == webview.label()) { slots.remove(&id); }
    }
}

pub use commands::*;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    use russh::keys::HashAlg;
    use russh::server::{self, Msg, Server as _, Session};
    use russh::{Channel, ChannelId};
    use tokio::net::TcpListener;
    use zeroize::Zeroizing;

    use crate::sftp_client::UNKNOWN_HOST;
    use crate::ssh_connect::Auth;

    // ── parsing ────────────────────────────────────────────────────────────

    fn sample_output(stat: &str) -> String {
        format!("@@uname\nLinux\n6.8.0-45-generic\nx86_64\n@@host\nweb-01\n@@osrel\nNAME=\"Ubuntu\"\nVERSION=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n\
@@uptime\n93784.52 180000.00\n@@load\n0.52 0.61 0.70 2/345 12345\n@@stat\n{stat}\n\
@@cpuinfo\nmodel name\t: AMD EPYC 7B13\n\
@@mem\nMemTotal:        2000000 kB\nMemFree:          300000 kB\nMemAvailable:    1500000 kB\nBuffers:           50000 kB\nCached:           600000 kB\nSReclaimable:      50000 kB\nSwapTotal:       1000000 kB\nSwapFree:         750000 kB\n\
@@mounts\n/dev/sda1 / ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/sdb1 /mnt/my\\040data xfs rw 0 0\n/dev/sda1 /var/lib/docker ext4 rw 0 0\n/dev/loop3 /snap/core/1 squashfs ro 0 0\noverlay /var/lib/docker/overlay2/x/merged overlay rw 0 0\n\
@@df\nFilesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/sda1         40000000  10000000  30000000      25% /\ntmpfs               200000        10    199990       1% /run\n/dev/sdb1        100000000  90000000  10000000      90% /mnt/my data\n/dev/sda1         40000000  10000000  30000000      25% /var/lib/docker\n/dev/loop3           60000     60000         0     100% /snap/core/1\noverlay           40000000  10000000  30000000      25% /var/lib/docker/overlay2/x/merged\n@@end\n")
    }

    const STAT1: &str = "cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 50 0 50 350 50 0 0 0 0 0\ncpu1 50 0 50 350 50 0 0 0 0 0";
    const STAT2: &str = "cpu  200 0 200 1300 300 0 0 0 0 0\ncpu0 100 0 100 650 150 0 0 0 0 0\ncpu1 100 0 100 650 150 0 0 0 0 0";

    #[test]
    fn reads_a_linux_server() {
        let (ov, sample) = parse(&sample_output(STAT1));
        assert!(ov.supported);
        assert_eq!(ov.system, "Linux");
        assert_eq!(ov.hostname.as_deref(), Some("web-01"));
        assert_eq!(ov.os.as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(ov.kernel.as_deref(), Some("6.8.0-45-generic"));
        assert_eq!(ov.arch.as_deref(), Some("x86_64"));
        assert_eq!(ov.cpu_model.as_deref(), Some("AMD EPYC 7B13"));
        assert_eq!(ov.uptime_secs, Some(93784));
        assert_eq!(ov.load, Some([0.52, 0.61, 0.70]));
        assert_eq!(ov.cores, Some(2));
        assert_eq!(sample, Some(CpuSample { total: 1000, idle: 800 }));
        let m = ov.memory.unwrap();
        assert_eq!((m.total, m.available, m.used), (2_000_000 * 1024, 1_500_000 * 1024, 500_000 * 1024));
        assert_eq!(m.cached, 700_000 * 1024);
        let s = ov.swap.unwrap();
        assert_eq!((s.total, s.used), (1_000_000 * 1024, 250_000 * 1024));
        // Real filesystems only, once each (a bind mount of / isn't repeated), with spaces in names kept.
        let mounts: Vec<_> = ov.disks.iter().map(|d| (d.mount.as_str(), d.fs_type.as_str())).collect();
        assert_eq!(mounts, vec![("/", "ext4"), ("/mnt/my data", "xfs")]);
        assert_eq!(ov.disks[1].used, 90_000_000 * 1024);
        assert_eq!(ov.disks_more, 0);
    }

    #[test]
    fn cpu_usage_comes_from_two_samples() {
        let a = parse(&sample_output(STAT1)).1.unwrap();
        let b = parse(&sample_output(STAT2)).1.unwrap();
        // 1000 more ticks, of which 800 idle (600 idle + 200 iowait): 20 % busy.
        assert_eq!(cpu_percent(&a, &b), Some(20.0));
        assert_eq!(cpu_percent(&b, &a), None, "counters going back (a reboot) give nothing");
        assert_eq!(cpu_percent(&a, &a), None);
    }

    #[test]
    fn another_system_is_not_supported() {
        let (ov, s) = parse("@@uname\nFreeBSD\n14.1\namd64\n@@host\nbsd\n@@stat\ncpu 1 2 3 4\n@@end\n");
        assert!(!ov.supported);
        assert_eq!(ov.system, "FreeBSD");
        assert!(ov.memory.is_none() && ov.disks.is_empty() && s.is_none() && ov.kernel.is_none());
        // No output at all (no `sh`, e.g. a Windows server): not supported, nothing made up.
        let (ov, _) = parse("");
        assert!(!ov.supported && ov.system.is_empty());
        let (ov, _) = parse("'sh' is not recognized as an internal or external command");
        assert!(!ov.supported);
    }

    #[test]
    fn hostile_output_is_cleaned_and_capped() {
        let long = "x".repeat(10_000);
        let mut out = format!("@@uname\nLinux\n{long}\n\x1b[31mx86\x07\n@@host\nevil\u{202e}\x1b]0;title\x07host\n@@osrel\nPRETTY_NAME=\"<script>alert(1)</script>{long}\"\n");
        // Nonsense numbers: negative, NaN, infinite, overflowing.
        out.push_str("@@uptime\n-5 0\n@@load\nNaN inf 1e400\n@@stat\ncpu 18446744073709551615 18446744073709551615 1 1\ncpuX 1 1 1 1\n");
        out.push_str("@@mem\nMemTotal: 18446744073709551615 kB\nMemAvailable: 99999999999999999999 kB\nSwapTotal: 10 kB\nSwapFree: 999 kB\n");
        out.push_str("@@mounts\n");
        for i in 0..5000 { out.push_str(&format!("/dev/sd{i} /m{i} ext4 rw 0 0\n")); }
        out.push_str("@@df\nFilesystem 1024-blocks Used Available Capacity Mounted on\n");
        for i in 0..100 { out.push_str(&format!("/dev/sd{i} 100 500 0 500% /m{i}\n")); }
        out.push_str("garbage line\n1 2 3 4% \n/dev/x 1 2 3 4% relative\n/dev/y 0 0 0 0% /zero\n");
        // A second section of the same name doesn't replace the first.
        out.push_str("@@uname\nPlan9\n");
        let (ov, sample) = parse(&out);
        assert!(ov.supported);
        assert_eq!(ov.kernel.as_ref().unwrap().chars().count(), 120);
        assert_eq!(ov.arch.as_deref(), Some("[31mx86"));
        assert!(ov.hostname.as_ref().unwrap().chars().all(|c| !c.is_control()));
        assert!(ov.os.as_ref().unwrap().chars().count() <= 120);
        assert_eq!((ov.uptime_secs, ov.load), (None, None));
        assert_eq!(sample, None, "an overflowing total is dropped");
        assert_eq!(ov.cores, None);
        let m = ov.memory.unwrap();
        assert!(m.used <= m.total && m.available <= m.total);
        let s = ov.swap.unwrap();
        assert_eq!(s.used, 0);
        assert_eq!(ov.disks.len(), MAX_DISKS);
        assert_eq!(ov.disks_more, 100 - MAX_DISKS as u32);
        assert!(ov.disks.iter().all(|d| d.used <= d.total && d.mount.starts_with('/')));
    }

    #[test]
    fn df_lines_with_spaces_and_odd_columns() {
        assert_eq!(parse_df_line("/dev/sda1 100 40 60 40% /"), Some(("/dev/sda1".into(), 102_400, 40_960, 61_440, "/".into())));
        assert_eq!(parse_df_line("//nas/my share 100 40 60 40% /mnt/a b").map(|d| (d.0, d.4)), Some(("//nas/my share".into(), "/mnt/a b".into())));
        assert_eq!(parse_df_line("/dev/sda1 100 40 60 40%"), None);
        assert_eq!(parse_df_line("Filesystem 1024-blocks Used Available Capacity Mounted on"), None);
        assert_eq!(unescape_mount("/mnt/a\\040b\\011c\\\\"), "/mnt/a b\tc\\\\");
        assert_eq!(unescape_mount("/x\\04"), "/x\\04");
    }

    #[test]
    fn a_container_still_shows_its_root() {
        let (disks, _) = parse_disks(&["overlay 100 50 50 50% /"], &["overlay / overlay rw 0 0"]);
        assert_eq!(disks.len(), 1);
        assert_eq!(disks[0].mount, "/");
    }

    #[test]
    fn the_command_is_fixed_and_read_only() {
        // Nothing in it writes, deletes or changes anything, and it has no placeholders to fill in.
        for bad in ["rm ", "mv ", ">", "dd ", "kill", "{", "$1", "$(", "`", "sudo", "chmod", "tee"] {
            let script = COMMAND.replace("2>/dev/null", "").replace(">/dev/null 2>&1", "");
            assert!(!script.contains(bad), "{bad}");
        }
        assert!(COMMAND.starts_with("sh -c '") && COMMAND.ends_with('\'') && COMMAND.matches('\'').count() == 2);
    }

    // ── against an in-process SSH server ───────────────────────────────────

    #[derive(Clone, Copy, PartialEq)]
    enum Reply { Normal, Flood, Silent, NoExec }

    #[derive(Clone)]
    struct Srv { reply: Reply, polls: Arc<StdMutex<Vec<String>>> }

    impl server::Server for Srv {
        type Handler = Self;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self { self.clone() }
    }

    impl server::Handler for Srv {
        type Error = russh::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<server::Auth, Self::Error> {
            Ok(if user == "alice" && password == "pw" { server::Auth::Accept } else { server::Auth::reject() })
        }

        async fn channel_open_session(&mut self, _c: Channel<Msg>, reply: server::ChannelOpenHandle, _s: &mut Session) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn exec_request(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
            let n = { let mut p = self.polls.lock().unwrap(); p.push(String::from_utf8_lossy(data).into_owned()); p.len() };
            match self.reply {
                Reply::NoExec => { let _ = session.channel_failure(channel); }
                Reply::Silent => { let _ = session.channel_success(channel); }
                Reply::Normal => {
                    let _ = session.channel_success(channel);
                    let _ = session.data(channel, sample_output(if n % 2 == 1 { STAT1 } else { STAT2 }).into_bytes());
                    let _ = session.exit_status_request(channel, 0);
                    let _ = session.eof(channel);
                    let _ = session.close(channel);
                }
                Reply::Flood => {
                    let _ = session.channel_success(channel);
                    let h = session.handle();
                    tokio::spawn(async move {
                        for _ in 0..64 { if h.data(channel, vec![b'A'; 32 * 1024]).await.is_err() { break; } }
                    });
                }
            }
            Ok(())
        }
    }

    struct Fixture { port: u16, fp: String, polls: Arc<StdMutex<Vec<String>>> }

    async fn start(reply: Reply) -> Fixture {
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
        let polls = Arc::new(StdMutex::new(Vec::new()));
        let mut srv = Srv { reply, polls: polls.clone() };
        tokio::spawn(async move { let _ = srv.run_on_socket(cfg, &listener).await; });
        Fixture { port, fp, polls }
    }

    fn connect(port: u16, pinned: Option<String>) -> Connect {
        Connect {
            title: "test".into(), host: "127.0.0.1".into(), port, user: "alice".into(), jump: None, pinned_fp: pinned,
            auth: Auth::Password, key: None, passphrase: None, password: Some(Zeroizing::new("pw".into())),
        }
    }

    fn known() -> KnownHosts {
        KnownHosts::new(std::env::temp_dir().join(format!("notiq-overview-{:x}", rand::random::<u64>())).join("known.json"))
    }

    #[tokio::test]
    async fn polls_run_only_the_fixed_command_and_measure_cpu() {
        let f = start(Reply::Normal).await;
        let m = Monitor::open(connect(f.port, Some(f.fp.clone())), known(), None).await.expect("sign in");
        let first = m.poll().await.unwrap();
        assert!(first.supported && first.cpu_percent.is_none(), "one sample isn't enough for a percentage");
        let second = m.poll().await.unwrap();
        assert_eq!(second.cpu_percent, Some(20.0));
        assert_eq!(second.disks.len(), 2);
        assert_eq!(*f.polls.lock().unwrap(), vec![COMMAND.to_string(), COMMAND.to_string()]);
    }

    #[tokio::test]
    async fn an_untrusted_host_needs_the_users_approval_and_a_changed_key_is_refused() {
        let f = start(Reply::Normal).await;
        let hosts = known();
        let err = Monitor::open(connect(f.port, None), hosts.clone(), None).await.err().expect("not trusted yet");
        let host: UnknownHost = serde_json::from_str(err.strip_prefix(UNKNOWN_HOST).expect("asks")).unwrap();
        assert_eq!(host.fp, f.fp);
        assert!(f.polls.lock().unwrap().is_empty(), "nothing ran before the approval");
        Monitor::open(connect(f.port, None), hosts.clone(), Some(host.clone())).await.expect("approved").poll().await.unwrap();
        hosts.remember("127.0.0.1", f.port, &host.alg, "SHA256:old").unwrap();
        let refused = Monitor::open(connect(f.port, None), hosts, Some(host)).await.err().expect("changed key");
        assert!(refused.contains("HOST KEY") && !refused.starts_with(UNKNOWN_HOST), "{refused}");
    }

    #[tokio::test]
    async fn too_much_output_or_no_answer_ends_the_poll() {
        let f = start(Reply::Flood).await;
        let m = Monitor::open(connect(f.port, Some(f.fp.clone())), known(), None).await.unwrap();
        assert!(m.poll().await.unwrap_err().contains("far more"));

        let f = start(Reply::Silent).await;
        let mut m = Monitor::open(connect(f.port, Some(f.fp.clone())), known(), None).await.unwrap();
        m.limit = Duration::from_millis(300);
        assert!(m.poll().await.unwrap_err().contains("too long"));

        let f = start(Reply::NoExec).await;
        let m = Monitor::open(connect(f.port, Some(f.fp.clone())), known(), None).await.unwrap();
        assert_eq!(m.poll().await.unwrap_err(), NO_EXEC);
    }

    #[tokio::test]
    async fn polls_never_overlap() {
        let f = start(Reply::Silent).await;
        let mut m = Monitor::open(connect(f.port, Some(f.fp.clone())), known(), None).await.unwrap();
        m.limit = Duration::from_millis(500);
        let m = Arc::new(m);
        let slow = { let m = m.clone(); tokio::spawn(async move { m.poll().await }) };
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(m.poll().await.unwrap_err(), BUSY);
        assert!(slow.await.unwrap().is_err());
        assert_eq!(f.polls.lock().unwrap().len(), 1);
    }
}
