//! Native-messaging registration for the browser autofill bridge: status and repair.
//!
//! The browser finds the native host through a JSON manifest (`name`, `path` = the Notiq exe, `type: stdio`,
//! plus the extension IDs allowed to talk to it):
//!
//! * **Windows** — the manifest lives in Notiq's app-data folder; an `HKCU\<browser>\NativeMessagingHosts\<name>`
//!   registry key's default value points at it. Chromium browsers share one manifest (`allowed_origins`), Firefox
//!   gets its own (`allowed_extensions`).
//! * **Linux** — the manifest file itself is written into each browser's per-user `NativeMessagingHosts` folder.
//! * **macOS** — not supported in this release: no browsers are listed and Repair does nothing.
//!
//! Release builds register at startup (as before). A dev build never does so on its own, because the host name is
//! shared with the installed app; it only registers when the user explicitly presses Repair, and then it points the
//! browsers at the *dev* exe and says so in the result.
#![cfg_attr(target_os = "macos", allow(dead_code))]

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use crate::autofill::{self, HOST_NAME};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Chromium,
    Firefox,
}

/// One supported browser on this platform.
#[derive(Debug)]
#[allow(dead_code)] // `app_exe` is only read on Windows
pub struct Browser {
    pub name: &'static str,
    pub kind: Kind,
    /// Windows: `HKCU\<reg_base>\<HOST_NAME>`. Linux: `~/<reg_base>/<HOST_NAME>.json`.
    pub reg_base: &'static str,
    /// Windows: the exe name under `App Paths`. Linux: unused.
    pub app_exe: &'static str,
    /// Windows: the vendor registry key (HKCU / HKLM). Linux: the profile folder under `~`.
    pub detect: &'static str,
}

#[cfg(windows)]
pub const BROWSERS: &[Browser] = &[
    Browser { name: "Chrome", kind: Kind::Chromium, reg_base: "Software\\Google\\Chrome\\NativeMessagingHosts", app_exe: "chrome.exe", detect: "Software\\Google\\Chrome" },
    Browser { name: "Edge", kind: Kind::Chromium, reg_base: "Software\\Microsoft\\Edge\\NativeMessagingHosts", app_exe: "msedge.exe", detect: "Software\\Microsoft\\Edge" },
    Browser { name: "Brave", kind: Kind::Chromium, reg_base: "Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts", app_exe: "brave.exe", detect: "Software\\BraveSoftware\\Brave-Browser" },
    Browser { name: "Firefox", kind: Kind::Firefox, reg_base: "Software\\Mozilla\\NativeMessagingHosts", app_exe: "firefox.exe", detect: "Software\\Mozilla\\Mozilla Firefox" },
];

#[cfg(all(unix, not(target_os = "macos")))]
pub const BROWSERS: &[Browser] = &[
    Browser { name: "Chrome", kind: Kind::Chromium, reg_base: ".config/google-chrome/NativeMessagingHosts", app_exe: "", detect: ".config/google-chrome" },
    Browser { name: "Chromium", kind: Kind::Chromium, reg_base: ".config/chromium/NativeMessagingHosts", app_exe: "", detect: ".config/chromium" },
    Browser { name: "Edge", kind: Kind::Chromium, reg_base: ".config/microsoft-edge/NativeMessagingHosts", app_exe: "", detect: ".config/microsoft-edge" },
    Browser { name: "Brave", kind: Kind::Chromium, reg_base: ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts", app_exe: "", detect: ".config/BraveSoftware/Brave-Browser" },
    Browser { name: "Firefox", kind: Kind::Firefox, reg_base: ".mozilla/native-messaging-hosts", app_exe: "", detect: ".mozilla" },
];

/// macOS (and anything else): not supported in this release.
#[cfg(not(any(windows, all(unix, not(target_os = "macos")))))]
pub const BROWSERS: &[Browser] = &[];

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

/// The manifest a browser of `kind` reads. `chromium_ids` are 32-char extension IDs, `firefox_ids` gecko IDs.
pub fn build_manifest(kind: Kind, exe: &str, chromium_ids: &[String], firefox_ids: &[&str]) -> Value {
    let mut m = json!({
        "name": HOST_NAME,
        "description": "Notiq autofill bridge",
        "path": exe,
        "type": "stdio",
    });
    match kind {
        Kind::Chromium => {
            m["allowed_origins"] = json!(chromium_ids.iter().map(|id| format!("chrome-extension://{id}/")).collect::<Vec<_>>());
        }
        Kind::Firefox => m["allowed_extensions"] = json!(firefox_ids),
    }
    m
}

fn norm_path(p: &str) -> String {
    let p = p.trim().trim_matches('"');
    let p = p.strip_prefix("\\\\?\\").unwrap_or(p);
    if cfg!(windows) {
        p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
    } else {
        p.trim_end_matches('/').to_string()
    }
}

/// Same file path? Case-insensitive and slash-agnostic on Windows, ignores the `\\?\` prefix.
pub fn same_path(a: &str, b: &str) -> bool {
    !a.trim().is_empty() && norm_path(a) == norm_path(b)
}

/// Does `manifest` allow every ID the app currently knows?
pub fn ids_ok(kind: Kind, manifest: &Value, chromium_ids: &[String], firefox_ids: &[&str]) -> bool {
    let (key, want): (&str, Vec<String>) = match kind {
        Kind::Chromium => ("allowed_origins", chromium_ids.iter().map(|id| format!("chrome-extension://{id}/")).collect()),
        Kind::Firefox => ("allowed_extensions", firefox_ids.iter().map(|s| s.to_string()).collect()),
    };
    let have: Vec<&str> = manifest.get(key).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
    !want.is_empty() && want.iter().all(|w| have.contains(&w.as_str()))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BrowserStatus {
    pub name: String,
    /// The browser seems to be installed for this user.
    pub installed: bool,
    /// A registration exists and its manifest file can be read.
    pub registered: bool,
    pub manifest_path: Option<String>,
    /// The manifest points at this very exe (false = "points to another copy of Notiq").
    pub path_matches_current_exe: bool,
    /// The manifest allows every known extension ID.
    pub ids_ok: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LastRequest {
    pub at_ms: u64,
    pub host: String,
    pub outcome: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AutofillStatus {
    pub browsers: Vec<BrowserStatus>,
    /// The app's local listener is up and its `{port, token}` file is current.
    pub ipc_ok: bool,
    pub extension_last_seen_ms: Option<u64>,
    pub last_request: Option<LastRequest>,
    pub native_host_exe: String,
    pub is_dev: bool,
    /// Set by `autofill_repair`: what was done (human-readable).
    pub note: Option<String>,
    /// False on platforms without native-messaging support in this release (macOS).
    pub supported: bool,
}

/// One browser's status from what was found on disk / in the registry.
#[allow(clippy::too_many_arguments)]
pub fn assess(
    name: &str,
    kind: Kind,
    installed: bool,
    manifest_path: Option<String>,
    manifest: Option<&Value>,
    exe: &str,
    chromium_ids: &[String],
    firefox_ids: &[&str],
) -> BrowserStatus {
    let registered = manifest_path.is_some() && manifest.is_some();
    let path_matches = manifest
        .and_then(|m| m.get("path"))
        .and_then(|p| p.as_str())
        .map(|p| same_path(p, exe))
        .unwrap_or(false);
    let ids = manifest.map(|m| ids_ok(kind, m, chromium_ids, firefox_ids)).unwrap_or(false);
    BrowserStatus {
        name: name.to_string(),
        installed,
        registered,
        manifest_path,
        path_matches_current_exe: registered && path_matches,
        ids_ok: registered && ids,
    }
}

/// Inputs for one browser, as probed from the system.
pub struct Probe {
    pub installed: bool,
    pub manifest_path: Option<String>,
    pub manifest: Option<Value>,
}

/// Assembles the full status from injected inputs (no system access).
#[allow(clippy::too_many_arguments)]
pub fn assemble_status(
    browsers: &[Browser],
    probes: &[Probe],
    exe: &str,
    chromium_ids: &[String],
    firefox_ids: &[&str],
    ipc_ok: bool,
    extension_last_seen_ms: Option<u64>,
    last_request: Option<LastRequest>,
    is_dev: bool,
) -> AutofillStatus {
    let browsers = browsers
        .iter()
        .zip(probes)
        .map(|(b, p)| assess(b.name, b.kind, p.installed, p.manifest_path.clone(), p.manifest.as_ref(), exe, chromium_ids, firefox_ids))
        .collect();
    AutofillStatus {
        browsers,
        ipc_ok,
        extension_last_seen_ms,
        last_request,
        native_host_exe: exe.to_string(),
        is_dev,
        note: None,
        supported: cfg!(any(windows, all(unix, not(target_os = "macos")))),
    }
}

/// Human-readable summary of a repair.
pub fn repair_note(done: &[String], failed: &[(String, String)], is_dev: bool, exe: &str) -> String {
    let mut s = if done.is_empty() && failed.is_empty() {
        "No supported browser was found, nothing was registered.".to_string()
    } else if done.is_empty() {
        "Registration failed.".to_string()
    } else {
        format!("Registered for {}.", done.join(", "))
    };
    if !failed.is_empty() {
        let f: Vec<String> = failed.iter().map(|(b, e)| format!("{b} ({e})")).collect();
        s.push_str(&format!(" Failed: {}.", f.join(", ")));
    }
    if is_dev && !done.is_empty() {
        s.push_str(&format!(
            " This is a development build: the browsers now start this dev exe ({exe}). Start the installed Notiq (or press Repair there) to point them back."
        ));
    }
    s
}

// ─── System access ───────────────────────────────────────────────────────────

fn current_exe_string() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

fn read_manifest(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok().filter(|v| v.is_object())
}

#[cfg(windows)]
fn probe(b: &Browser) -> Probe {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let app_paths = format!("Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{}", b.app_exe);
    let installed = hkcu.open_subkey(&app_paths).is_ok()
        || hklm.open_subkey(&app_paths).is_ok()
        || hklm.open_subkey(format!("Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{}", b.app_exe)).is_ok()
        || hkcu.open_subkey(b.detect).is_ok()
        || hklm.open_subkey(b.detect).is_ok();
    let manifest_path: Option<String> = hkcu
        .open_subkey(format!("{}\\{HOST_NAME}", b.reg_base))
        .ok()
        .and_then(|k| k.get_value::<String, _>("").ok())
        .filter(|s| !s.trim().is_empty());
    let manifest = manifest_path.as_deref().and_then(|p| read_manifest(Path::new(p)));
    Probe { installed, manifest_path, manifest }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn probe(b: &Browser) -> Probe {
    let Some(home) = home() else { return Probe { installed: false, manifest_path: None, manifest: None } };
    let installed = home.join(b.detect).is_dir();
    let path = home.join(b.reg_base).join(format!("{HOST_NAME}.json"));
    let manifest = read_manifest(&path);
    let manifest_path = path.exists().then(|| path.to_string_lossy().into_owned());
    Probe { installed, manifest_path, manifest }
}

#[cfg(not(any(windows, all(unix, not(target_os = "macos")))))]
fn probe(_b: &Browser) -> Probe {
    Probe { installed: false, manifest_path: None, manifest: None }
}

/// Registers one browser. Windows: (re)writes the shared manifest for its kind and the HKCU key.
#[cfg(windows)]
fn register_one(b: &Browser, exe: &str, ids: &[String], dir: &Path) -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let file = match b.kind {
        Kind::Chromium => format!("{HOST_NAME}.json"),
        Kind::Firefox => format!("{HOST_NAME}.firefox.json"),
    };
    let mpath = dir.join(file);
    let manifest = build_manifest(b.kind, exe, ids, autofill::FIREFOX_EXTENSION_IDS);
    crate::vault::atomic_write(&mpath, manifest.to_string().as_bytes())?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (k, _) = hkcu.create_subkey(format!("{}\\{HOST_NAME}", b.reg_base)).map_err(|e| e.to_string())?;
    k.set_value("", &mpath.to_string_lossy().as_ref()).map_err(|e| e.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn register_one(b: &Browser, exe: &str, ids: &[String], _dir: &Path) -> Result<(), String> {
    let home = home().ok_or("no HOME")?;
    let path = home.join(b.reg_base).join(format!("{HOST_NAME}.json"));
    let manifest = build_manifest(b.kind, exe, ids, autofill::FIREFOX_EXTENSION_IDS);
    crate::vault::atomic_write(&path, serde_json::to_string_pretty(&manifest).unwrap_or_default().as_bytes())
}

#[cfg(not(any(windows, all(unix, not(target_os = "macos")))))]
fn register_one(_b: &Browser, _exe: &str, _ids: &[String], _dir: &Path) -> Result<(), String> {
    Err("not supported on this platform".into())
}

/// Registers the browsers selected by `pick`. Returns (registered names, failures).
fn register_where(pick: impl Fn(&Browser, &Probe) -> bool) -> (Vec<String>, Vec<(String, String)>) {
    let exe = current_exe_string();
    let mut done = Vec::new();
    let mut failed = Vec::new();
    if exe.is_empty() {
        return (done, vec![("all".into(), "cannot resolve the Notiq exe path".into())]);
    }
    let Some(dir) = autofill::data_dir_plain() else {
        return (done, vec![("all".into(), "no app-data folder".into())]);
    };
    let ids = autofill::known_extension_ids();
    for b in BROWSERS {
        if !pick(b, &probe(b)) {
            continue;
        }
        match register_one(b, &exe, &ids, &dir) {
            Ok(()) => done.push(b.name.to_string()),
            Err(e) => failed.push((b.name.to_string(), e)),
        }
    }
    (done, failed)
}

/// Startup registration for release builds. Keeps the pre-0.7 behaviour on Windows (Chrome, Edge and Brave are
/// always registered, the key is harmless when a browser is missing) and adds any other installed browser.
pub fn register_at_startup() {
    if crate::profile::IS_DEV {
        return; // a dev build never touches the installed app's registration on its own
    }
    let _ = register_where(|b, p| p.installed || (cfg!(windows) && b.kind == Kind::Chromium));
}

fn status_now() -> AutofillStatus {
    let exe = current_exe_string();
    let ids = autofill::known_extension_ids();
    let probes: Vec<Probe> = BROWSERS.iter().map(probe).collect();
    assemble_status(
        BROWSERS,
        &probes,
        &exe,
        &ids,
        autofill::FIREFOX_EXTENSION_IDS,
        autofill::ipc_ok(),
        autofill::extension_last_seen_ms(),
        autofill::last_request(),
        crate::profile::IS_DEV,
    )
}

/// Registration and bridge health for Settings → Browser autofill.
#[tauri::command(async)]
pub fn autofill_status() -> AutofillStatus {
    status_now()
}

/// Re-registers the native host for every installed browser. An explicit user action, so it also works in a dev
/// build (which then registers the dev exe, and the note says so).
#[tauri::command(async)]
pub fn autofill_repair() -> AutofillStatus {
    let (done, failed) = register_where(|_, p| p.installed);
    let mut s = status_now();
    s.note = Some(if s.supported {
        repair_note(&done, &failed, crate::profile::IS_DEV, &s.native_host_exe)
    } else {
        "Browser autofill isn't supported on this platform yet.".to_string()
    });
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> Vec<String> {
        vec!["cfddmbiaaboejbhnijkjodcganjdbcel".into(), "abcdefghijklmnopabcdefghijklmnop".into()]
    }

    #[test]
    fn chromium_manifest_lists_every_origin() {
        let m = build_manifest(Kind::Chromium, "C:\\Notiq\\notiq.exe", &ids(), &["autofill@notiq.app"]);
        assert_eq!(m["name"], HOST_NAME);
        assert_eq!(m["type"], "stdio");
        assert_eq!(m["path"], "C:\\Notiq\\notiq.exe");
        assert_eq!(
            m["allowed_origins"],
            json!(["chrome-extension://cfddmbiaaboejbhnijkjodcganjdbcel/", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"])
        );
        assert!(m.get("allowed_extensions").is_none());
    }

    #[test]
    fn firefox_manifest_uses_allowed_extensions() {
        let m = build_manifest(Kind::Firefox, "/opt/notiq", &ids(), &["autofill@notiq.app"]);
        assert_eq!(m["allowed_extensions"], json!(["autofill@notiq.app"]));
        assert!(m.get("allowed_origins").is_none());
    }

    #[test]
    fn path_comparison() {
        assert!(same_path("/opt/notiq/notiq", "/opt/notiq/notiq"));
        assert!(!same_path("/opt/notiq/notiq", "/opt/other/notiq"));
        assert!(!same_path("", ""));
        if cfg!(windows) {
            assert!(same_path("C:\\Program Files\\Notiq\\Notiq.exe", "c:/program files/notiq/notiq.exe"));
            assert!(same_path("\\\\?\\C:\\Notiq\\notiq.exe", "C:\\Notiq\\notiq.exe"));
        }
    }

    #[test]
    fn ids_check_needs_all_known_ids() {
        let full = build_manifest(Kind::Chromium, "x", &ids(), &[]);
        assert!(ids_ok(Kind::Chromium, &full, &ids(), &[]));
        let partial = build_manifest(Kind::Chromium, "x", &ids()[..1], &[]);
        assert!(!ids_ok(Kind::Chromium, &partial, &ids(), &[]));
        assert!(!ids_ok(Kind::Chromium, &json!({}), &ids(), &[]));
        let ff = build_manifest(Kind::Firefox, "x", &[], &["autofill@notiq.app"]);
        assert!(ids_ok(Kind::Firefox, &ff, &[], &["autofill@notiq.app"]));
        assert!(!ids_ok(Kind::Firefox, &ff, &[], &[]));
    }

    #[test]
    fn status_assembly_with_injected_inputs() {
        let table = [
            Browser { name: "A", kind: Kind::Chromium, reg_base: "", app_exe: "", detect: "" },
            Browser { name: "B", kind: Kind::Chromium, reg_base: "", app_exe: "", detect: "" },
            Browser { name: "C", kind: Kind::Chromium, reg_base: "", app_exe: "", detect: "" },
            Browser { name: "D", kind: Kind::Firefox, reg_base: "", app_exe: "", detect: "" },
        ];
        let exe = "/opt/notiq/notiq";
        let ff: &[&str] = &["autofill@notiq.app"];
        let probes = vec![
            Probe { installed: true, manifest_path: Some("/m/a.json".into()), manifest: Some(build_manifest(Kind::Chromium, exe, &ids(), ff)) },
            Probe { installed: true, manifest_path: Some("/m/b.json".into()), manifest: Some(build_manifest(Kind::Chromium, "/old/notiq", &ids()[..1], ff)) },
            Probe { installed: false, manifest_path: Some("/m/missing.json".into()), manifest: None },
            Probe { installed: true, manifest_path: Some("/m/d.json".into()), manifest: Some(build_manifest(Kind::Firefox, exe, &ids(), ff)) },
        ];
        let lr = LastRequest { at_ms: 5, host: "example.com".into(), outcome: "ok".into() };
        let s = assemble_status(&table, &probes, exe, &ids(), ff, true, Some(42), Some(lr.clone()), false);
        assert_eq!(s.browsers.len(), 4);
        let a = &s.browsers[0];
        assert!(a.registered && a.path_matches_current_exe && a.ids_ok);
        let b = &s.browsers[1];
        assert!(b.registered && !b.path_matches_current_exe && !b.ids_ok);
        let c = &s.browsers[2];
        assert!(!c.installed && !c.registered && !c.path_matches_current_exe && !c.ids_ok);
        assert!(s.browsers[3].ids_ok && s.browsers[3].path_matches_current_exe);
        assert!(s.ipc_ok);
        assert_eq!(s.extension_last_seen_ms, Some(42));
        assert_eq!(s.last_request, Some(lr));
        assert_eq!(s.native_host_exe, exe);
        assert!(!s.is_dev);
        assert!(s.note.is_none());
        // Serialised field names are the documented snake_case ones.
        let v = serde_json::to_value(&s).unwrap();
        assert!(v["browsers"][0].get("path_matches_current_exe").is_some());
        assert!(v.get("extension_last_seen_ms").is_some());
    }

    #[test]
    fn repair_note_mentions_dev_exe() {
        let n = repair_note(&["Chrome".into()], &[], true, "C:\\dev\\notiq.exe");
        assert!(n.contains("Chrome") && n.contains("development build") && n.contains("C:\\dev\\notiq.exe"));
        let n = repair_note(&["Chrome".into()], &[("Edge".into(), "denied".into())], false, "x");
        assert!(n.contains("Failed: Edge (denied)") && !n.contains("development"));
        assert!(repair_note(&[], &[], false, "x").contains("No supported browser"));
    }
}

// ─── browser extension: where it is and how to open its install page ─────────

/// The folder with the extension's files that ships with the app (`browser-extension/` next to the exe /
/// in the bundle's resources). Dev builds fall back to the repository copy.
fn extension_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let bundled = app.path().resource_dir().ok().map(|d| d.join("browser-extension"));
    if let Some(d) = bundled.filter(|d| d.join("manifest.json").exists()) {
        return Some(d);
    }
    if crate::profile::IS_DEV {
        let d = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("browser-extension");
        if d.join("manifest.json").exists() {
            return d.canonicalize().ok();
        }
    }
    None
}

/// Folder to point "Load unpacked" at, or None if the extension files aren't there.
#[tauri::command]
pub fn autofill_extension_dir(app: tauri::AppHandle) -> Option<String> {
    extension_dir(&app).map(|d| plain_path(&d))
}

/// Resource paths come back in Windows' `\\?\` verbatim form, which a browser's folder picker doesn't accept.
fn plain_path(p: &std::path::Path) -> String {
    p.to_string_lossy().trim_start_matches(r"\\?\").to_string()
}

/// Opens the extension folder in the file manager.
#[tauri::command]
pub fn autofill_open_extension_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = extension_dir(&app).ok_or("The extension files weren't found next to this installation")?;
    app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>).map_err(|e| e.to_string())
}

/// (program, page) for the browsers the extension supports. A fixed allow-list: nothing from the UI is
/// ever put on a command line.
fn browser_launch_spec(browser: &str) -> Option<(&'static str, &'static str)> {
    #[cfg(windows)]
    let exe = |win: &'static str, _linux: &'static str| win;
    #[cfg(not(windows))]
    let exe = |_win: &'static str, linux: &'static str| linux;
    match browser {
        "edge" => Some((exe("msedge", "microsoft-edge"), "edge://extensions")),
        "chrome" => Some((exe("chrome", "google-chrome"), "chrome://extensions")),
        "brave" => Some((exe("brave", "brave-browser"), "brave://extensions")),
        _ => None,
    }
}

/// Opens the browser's extensions page (where "Developer mode" and "Load unpacked" are).
#[tauri::command]
pub fn autofill_open_browser_extensions(browser: String) -> Result<(), String> {
    let (program, page) = browser_launch_spec(&browser).ok_or("Unsupported browser")?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `start` resolves the program through Windows' App Paths, like the Run dialog does.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", program, page])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(program).arg(page).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod extension_install_tests {
    use super::{browser_launch_spec, plain_path};

    #[test]
    fn verbatim_prefix_is_removed_from_the_folder_path() {
        let p = std::path::Path::new(r"\\?\C:\Users\me\AppData\Local\Notiq\browser-extension");
        assert_eq!(plain_path(p), r"C:\Users\me\AppData\Local\Notiq\browser-extension");
        assert_eq!(plain_path(std::path::Path::new(r"C:\x")), r"C:\x");
    }

    #[test]
    fn only_known_browsers_have_a_launch_spec() {
        for b in ["edge", "chrome", "brave"] {
            let (prog, page) = browser_launch_spec(b).expect("known browser");
            assert!(!prog.is_empty() && page.ends_with("://extensions"));
        }
        for bad in ["", "firefox", "cmd", "edge --evil", "../edge"] {
            assert!(browser_launch_spec(bad).is_none(), "{bad} must be refused");
        }
    }
}
