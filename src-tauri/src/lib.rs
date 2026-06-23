use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

mod ai;
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, image::Image,
};

/// Set once the frontend has called show_main_window. Prevents the 8 s safety
/// timer from overriding an intentional hide-to-tray.
static MAIN_SHOWN_ONCE: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn show_main_window(webview_window: tauri::WebviewWindow) {
    MAIN_SHOWN_ONCE.store(true, Ordering::Release);
    let _ = webview_window.show();
}

/// Returns the first non-flag CLI argument, i.e. a file path passed via
/// double-click / file-association open. Returns None when launched normally.
#[tauri::command]
fn get_open_file() -> Option<String> {
    std::env::args().nth(1).filter(|a| {
        !a.starts_with('-')
            && !a.contains("..")
            && a.len() < 32768
    })
}

// ─── Windows file-association & context-menu registration ────────────────────

#[cfg(windows)]
mod file_assoc {
    use winreg::RegKey;
    use winreg::enums::*;

    const PROG_ID: &str    = "Notiq.Note";
    const EXTS:    &[&str] = &[".md", ".markdown", ".txt", ".notiq"];

    pub fn register(exe: &str) {
        // Validate executable path contains no control characters or shell metacharacters
        if exe.chars().any(|c| c.is_control()) {
            eprintln!("file_assoc: executable path contains invalid characters, skipping registration");
            return;
        }
        if exe.contains('`') || exe.contains('$') || exe.contains('|') || exe.contains(';') || exe.contains('&') {
            eprintln!("file_assoc: executable path contains suspicious characters, skipping registration");
            return;
        }
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let classes = match hkcu.open_subkey_with_flags("Software\\Classes", KEY_ALL_ACCESS) {
            Ok(k) => k,
            Err(e) => {
                eprintln!("file_assoc: cannot open HKCU\\Software\\Classes: {}", e);
                return;
            }
        };

        // Resolve the bundled association icon sitting next to the executable.
        let assoc_icon = std::path::Path::new(exe)
            .parent()
            .map(|dir| dir.join("icons").join("association.ico"))
            .and_then(|p| if p.exists() { Some(p.to_string_lossy().into_owned()) } else { None });

        // ── ProgID ────────────────────────────────────────────────────────────
        if let Ok((prog, _)) = classes.create_subkey(PROG_ID) {
            let _ = prog.set_value("", &"Notiq Note");
            if let Ok((icon, _)) = prog.create_subkey("DefaultIcon") {
                let icon_val = match &assoc_icon {
                    Some(ico) => ico.clone(),
                    None => format!("{},0", exe),
                };
                let _ = icon.set_value("", &icon_val);
            }
            if let Ok((open, _)) = prog.create_subkey("shell\\open\\command") {
                let _ = open.set_value("", &format!("\"{}\" \"%1\"", exe));
            }
        }

        // ── Extension associations ────────────────────────────────────────────
        for ext in EXTS {
            if let Ok((key, _)) = classes.create_subkey(ext) {
                let _ = key.set_value("", &PROG_ID);
                if let Ok((ids, _)) = key.create_subkey("OpenWithProgids") {
                    let _ = ids.set_value(PROG_ID, &"");
                }
            }
        }

        // ── "Open with Notiq" on every file (*\shell) ─────────────────────────
        let verb = "*\\shell\\Open with Notiq";
        if let Ok((cmd, _)) = classes.create_subkey(format!("{}\\command", verb)) {
            let _ = cmd.set_value("", &format!("\"{}\" \"%1\"", exe));
        }
        if let Ok(parent) = classes.open_subkey_with_flags(verb, KEY_ALL_ACCESS) {
            let _ = parent.set_value("Icon", &format!("{},0", exe));
        }

        // ── Register under Applications\ so Notiq appears in "Open With" ────
        // Omitting SupportedTypes makes the app available for all file types,
        // similar to how Notepad++ registers itself.
        let exe_name = std::path::Path::new(exe)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Notiq.exe");
        if let Ok((app_key, _)) = classes.create_subkey(format!("Applications\\{}", exe_name)) {
            let _ = app_key.set_value("FriendlyAppName", &"Notiq");
            if let Ok((icon, _)) = app_key.create_subkey("DefaultIcon") {
                let icon_val = match &assoc_icon {
                    Some(ico) => ico.clone(),
                    None => format!("{},0", exe),
                };
                let _ = icon.set_value("", &icon_val);
            }
            if let Ok((open, _)) = app_key.create_subkey("shell\\open\\command") {
                let _ = open.set_value("", &format!("\"{}\" \"%1\"", exe));
            }
        }

        // ── "Open folder in Notiq" on directory right-click ───────────────────
        for (verb, arg) in [
            ("directory\\shell\\Open with Notiq",            "%1"),
            ("directory\\background\\shell\\Open with Notiq", "%W"),
        ] {
            if let Ok((cmd, _)) = classes.create_subkey(format!("{}\\command", verb)) {
                let _ = cmd.set_value("", &format!("\"{}\" \"{}\"", exe, arg));
            }
            if let Ok(parent) = classes.open_subkey_with_flags(verb, KEY_ALL_ACCESS) {
                let _ = parent.set_value("Icon", &format!("{},0", exe));
            }
        }

        // Notify Explorer to reload file-type associations immediately.
        // SAFETY: SHChangeNotify with SHCNE_ASSOCCHANGED + SHCNF_IDLIST accepts
        // null pointers for both dwItem1 and dwItem2 per Microsoft documentation.
        // This is a pure notification call with no memory access through the pointers.
        unsafe {
            windows_sys::Win32::UI::Shell::SHChangeNotify(
                windows_sys::Win32::UI::Shell::SHCNE_ASSOCCHANGED as i32,
                windows_sys::Win32::UI::Shell::SHCNF_IDLIST,
                std::ptr::null(),
                std::ptr::null(),
            );
        }
    }
}

// ─── Terminal (desktop-only) ──────────────────────────────────────────────────

#[cfg(desktop)]
mod term {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, mpsc};
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    use tauri::{AppHandle, Emitter, State};

    const TERMINAL_BUFFER_SIZE: usize = 4096;
    const TERMINAL_CHANNEL_CAPACITY: usize = 64;
    const MAX_TERMINAL_INPUT: usize = 16384; // 16 KB
    const MAX_TERMINAL_COLS: u16 = 300;
    const MAX_TERMINAL_ROWS: u16 = 100;

    /// Wrapper for `Box<dyn MasterPty>` to allow sending across threads.
    ///
    /// # Safety
    /// `portable_pty::MasterPty` on Windows wraps OS handles that are safe to use
    /// from any thread. We only ever access the inner `MasterPty` through an
    /// `Arc<Mutex<SendMaster>>`, ensuring exclusive access. The `Send` impl is
    /// required because `dyn MasterPty` is not `Send` by default (trait-object
    /// limitation), but the concrete Windows/Unix implementations are thread-safe.
    struct SendMaster(Box<dyn portable_pty::MasterPty>);
    unsafe impl Send for SendMaster {}

    pub(super) struct TermState {
        write_tx: mpsc::SyncSender<Vec<u8>>,
        master:   Arc<Mutex<SendMaster>>,
    }

    pub struct AppTerminal(pub(super) Arc<Mutex<HashMap<u32, TermState>>>);

    impl AppTerminal {
        pub fn new() -> Self {
            AppTerminal(Arc::new(Mutex::new(HashMap::new())))
        }
    }

    #[derive(serde::Serialize, Clone)]
    struct DataPayload { id: u32, data: String }

    #[derive(serde::Serialize, Clone)]
    struct ExitPayload { id: u32 }

    #[tauri::command]
    pub fn terminal_create(
        id:    u32,
        cols:  u16,
        rows:  u16,
        app:   AppHandle,
        state: State<'_, AppTerminal>,
    ) -> Result<String, String> {
        if cols == 0 || rows == 0 || cols > MAX_TERMINAL_COLS || rows > MAX_TERMINAL_ROWS {
            return Err("Invalid terminal dimensions".to_string());
        }
        let mut guard = state.0.lock()
            .map_err(|_| "Terminal state lock poisoned".to_string())?;
        if guard.contains_key(&id) {
            return Ok(String::new()); // already running — idempotent
        }

        let pty  = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;

        // Detect shell name to show in the tab title
        let (shell_name, mut cmd) = {
            #[cfg(windows)]
            {
                let mut c = CommandBuilder::new("powershell.exe");
                c.args(["-NoLogo"]);
                ("PowerShell".to_string(), c)
            }
            #[cfg(not(windows))]
            {
                let shell = std::env::var("SHELL")
                    .unwrap_or_else(|_| "/bin/bash".to_string());
                let name = shell
                    .rsplit('/')
                    .next()
                    .map(String::from)
                    .unwrap_or_else(|| "Shell".to_string());
                (name, CommandBuilder::new(shell))
            }
        };

        let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        if let Ok(home) = std::env::var(home_key) {
            cmd.cwd(home);
        }

        pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);

        let master = Arc::new(Mutex::new(SendMaster(pair.master)));

        // Reader thread — streams PTY output; clears session entry when shell exits
        let sessions_arc = Arc::clone(&state.0);
        {
            let mr   = master.clone();
            let app2 = app.clone();
            std::thread::spawn(move || {
                let mut reader = match mr.lock() {
                    Ok(guard) => match guard.0.try_clone_reader() {
                        Ok(r) => r,
                        Err(e) => {
                            eprintln!("terminal {}: failed to clone reader: {}", id, e);
                            return;
                        }
                    },
                    Err(e) => {
                        eprintln!("terminal {}: reader lock poisoned: {}", id, e);
                        return;
                    }
                };
                let mut buf = [0u8; TERMINAL_BUFFER_SIZE];
                loop {
                    match std::io::Read::read(&mut reader, &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                            let _ = app2.emit("terminal-data", DataPayload { id, data });
                        }
                    }
                }
                // Shell exited: remove session first so terminal_create can restart,
                // then notify the frontend.
                if let Ok(mut guard) = sessions_arc.lock() {
                    guard.remove(&id);
                }
                let _ = app2.emit("terminal-exit", ExitPayload { id });
            });
        }

        // Writer thread — forwards input bytes from the frontend to the PTY
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(TERMINAL_CHANNEL_CAPACITY);
        {
            let mw = master.clone();
            std::thread::spawn(move || {
                let mut writer = match mw.lock() {
                    Ok(guard) => match guard.0.take_writer() {
                        Ok(w) => w,
                        Err(e) => {
                            eprintln!("terminal {}: failed to take writer: {}", id, e);
                            return;
                        }
                    },
                    Err(e) => {
                        eprintln!("terminal {}: writer lock poisoned: {}", id, e);
                        return;
                    }
                };
                for data in rx {
                    if std::io::Write::write_all(&mut writer, &data).is_err() {
                        break;
                    }
                }
            });
        }

        guard.insert(id, TermState { write_tx: tx, master });
        Ok(shell_name)
    }

    #[tauri::command]
    pub fn terminal_write(
        id:    u32,
        data:  String,
        state: State<'_, AppTerminal>,
    ) -> Result<(), String> {
        if data.len() > MAX_TERMINAL_INPUT {
            return Err("Terminal input too large".to_string());
        }
        let guard = state.0.lock()
            .map_err(|_| "Terminal state lock poisoned".to_string())?;
        if let Some(ts) = guard.get(&id) {
            if let Err(e) = ts.write_tx.send(data.into_bytes()) {
                eprintln!("terminal {}: write channel error: {}", id, e);
            }
        }
        Ok(())
    }

    #[tauri::command]
    pub fn terminal_resize(
        id:    u32,
        cols:  u16,
        rows:  u16,
        state: State<'_, AppTerminal>,
    ) -> Result<(), String> {
        if cols == 0 || rows == 0 || cols > MAX_TERMINAL_COLS || rows > MAX_TERMINAL_ROWS {
            return Err("Invalid terminal dimensions".to_string());
        }
        let guard = state.0.lock()
            .map_err(|_| "Terminal state lock poisoned".to_string())?;
        if let Some(ts) = guard.get(&id) {
            ts.master.lock()
                .map_err(|_| "Terminal master lock poisoned".to_string())?
                .0.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    #[tauri::command]
    pub fn terminal_kill(id: u32, state: State<'_, AppTerminal>) -> Result<(), String> {
        // Dropping TermState closes write_tx channel → writer thread exits,
        // then the shell receives HUP from master being dropped.
        state.0.lock()
            .map_err(|_| "Terminal state lock poisoned".to_string())?
            .remove(&id);
        Ok(())
    }
}

// ─── System tray (desktop-only) ──────────────────────────────────────────────

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_i = MenuItem::with_id(app, "show", "Show Notiq", true, None::<&str>)?;
    let new_note_i = MenuItem::with_id(app, "new_note", "New Sticky Note", true, None::<&str>)?;
    let notes_list_i = MenuItem::with_id(app, "sticky_notes_list", "Sticky Notes", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &new_note_i, &notes_list_i, &sep, &quit_i])?;

    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Notiq")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "new_note" => {
                let _ = app.emit("open-sticky-note", ());
            }
            "sticky_notes_list" => {
                let _ = app.emit("open-sticky-notes-list", ());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        // If a file path was passed via file-association / CLI, emit it to the
        // frontend so it can open the file in a new tab.
        if let Some(file_path) = args.get(1).filter(|a| !a.starts_with('-')) {
            let _ = app.emit("open-file", file_path.clone());
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    #[cfg(desktop)]
    let builder = {
        use tauri_plugin_window_state::StateFlags;
        builder
            .manage(term::AppTerminal::new())
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(
                        StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED,
                    )
                    .build(),
            )
            // Auto-start on machine boot (cross-platform). The "--hidden" arg
            // is detected in `setup()` so an auto-launch starts in the tray
            // without stealing focus.
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--hidden"]),
            ))
            // Self-update (signed) + process control for relaunch after install.
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
    };

    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        show_main_window,
        get_open_file,
        term::terminal_create,
        term::terminal_write,
        term::terminal_resize,
        term::terminal_kill,
        ai::set_ai_api_key,
        ai::has_ai_api_key,
        ai::clear_ai_api_key,
        ai::ai_list_models,
        ai::ai_complete,
        ai::ai_complete_stream,
    ]);

    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        show_main_window,
        get_open_file,
        ai::set_ai_api_key,
        ai::has_ai_api_key,
        ai::clear_ai_api_key,
        ai::ai_list_models,
        ai::ai_complete,
        ai::ai_complete_stream,
    ]);

    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if window.label() == "main" {
                let _ = window.hide();
                api.prevent_close();
            }
        }
    });

    builder
        .setup(|app| {
            // Register file associations + context menu entries (Windows only)
            #[cfg(windows)]
            {
                let exe = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.to_str().map(String::from))
                    .unwrap_or_default();
                if !exe.is_empty() {
                    file_assoc::register(&exe);
                }
            }

            #[cfg(desktop)]
            setup_tray(app)?;

            // Detect `--hidden` (auto-start launch). When present, suppress the
            // 8 s safety-net show so the app stays in the tray on login.
            let auto_launched = std::env::args().any(|a| a == "--hidden");

            // Safety net: if the frontend never calls show_main_window within
            // 8 s (e.g. hydration failure), force-show so the user isn't stuck.
            // We check a flag that show_main_window sets to avoid overriding an
            // intentional hide-to-tray.
            if !auto_launched {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    if !MAIN_SHOWN_ONCE.load(Ordering::Acquire) {
                        if let Some(w) = handle.get_webview_window("main") {
                            if !w.is_visible().unwrap_or(true) {
                                let _ = w.show();
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Fatal: failed to run Tauri application: {}", e);
            std::process::exit(1);
        });
}
