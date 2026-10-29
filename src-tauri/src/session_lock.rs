//! Tells the frontend when the Windows session locks (Win+L), the PC suspends,
//! or a remote session disconnects, so the vault can be locked.
//!
//! A dedicated thread owns a hidden message-only window that receives
//! `WM_WTSSESSION_CHANGE` / `WM_POWERBROADCAST` and emits the Tauri event
//! `vault:session-lock` with payload `{ "reason": "lock" | "suspend" | "disconnect" }`.
//! No-op on other platforms.

/// Why the vault should lock. Serialised lowercase as the event payload `reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockReason {
    Lock,
    Suspend,
    Disconnect,
}

impl LockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            LockReason::Lock => "lock",
            LockReason::Suspend => "suspend",
            LockReason::Disconnect => "disconnect",
        }
    }
}

// Win32 message / notification codes (kept here so the decision logic is testable on any OS).
const WM_POWERBROADCAST: u32 = 0x0218;
const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const PBT_APMSUSPEND: usize = 0x0004;
const WTS_REMOTE_DISCONNECT: usize = 0x2;
const WTS_SESSION_LOCK: usize = 0x7;

/// Maps a window message to a lock reason, or None when it should be ignored.
pub fn reason_for(msg: u32, wparam: usize) -> Option<LockReason> {
    match (msg, wparam) {
        (WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK) => Some(LockReason::Lock),
        (WM_WTSSESSION_CHANGE, WTS_REMOTE_DISCONNECT) => Some(LockReason::Disconnect),
        (WM_POWERBROADCAST, PBT_APMSUSPEND) => Some(LockReason::Suspend),
        _ => None,
    }
}

#[cfg(windows)]
pub use imp::start;

#[cfg(not(windows))]
pub fn start(_app: &tauri::AppHandle) {}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::OnceLock;

    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Power::{RegisterSuspendResumeNotification, UnregisterSuspendResumeNotification};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        PostMessageW, PostQuitMessage, RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG,
        WM_CLOSE, WM_DESTROY, WNDCLASSW,
    };

    use super::reason_for;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// The message-only window (0 = none), so `Guard::drop` can ask it to close.
    static HWND_STORE: AtomicIsize = AtomicIsize::new(0);
    /// Handle from RegisterSuspendResumeNotification (0 = none). A message-only window does NOT get the
    /// broadcast WM_POWERBROADCAST, so suspend notifications have to be requested for it explicitly.
    static POWER_STORE: AtomicIsize = AtomicIsize::new(0);
    const DEVICE_NOTIFY_WINDOW_HANDLE: u32 = 0;

    /// Managed by Tauri; dropped when the app is torn down, which closes the window and ends the thread.
    pub struct Guard;

    impl Drop for Guard {
        fn drop(&mut self) {
            let hwnd = HWND_STORE.load(Ordering::Acquire);
            if hwnd != 0 {
                // SAFETY: posting a message to a window handle is safe even if the window is
                // already gone (the call just fails); WM_CLOSE is handled in `wnd_proc`.
                unsafe { PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0) };
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if let Some(reason) = reason_for(msg, wparam) {
            if let Some(app) = APP.get() {
                let _ = app.emit("vault:session-lock", serde_json::json!({ "reason": reason.as_str() }));
            }
            return 0;
        }
        match msg {
            WM_CLOSE => {
                // SAFETY: hwnd is the window this procedure belongs to, on its own thread.
                unsafe { DestroyWindow(hwnd) };
                0
            }
            WM_DESTROY => {
                // SAFETY: registered below with the same hwnd, on the same thread.
                unsafe {
                    WTSUnRegisterSessionNotification(hwnd);
                    let power = POWER_STORE.swap(0, Ordering::AcqRel);
                    if power != 0 {
                        UnregisterSuspendResumeNotification(power as _);
                    }
                    PostQuitMessage(0);
                }
                0
            }
            // SAFETY: default handling with the arguments we were given.
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }

    fn run_loop() {
        let class_name = wide("NotiqSessionLockWindow");
        // SAFETY: plain Win32 window setup on this thread; every pointer passed outlives the call
        // (class_name is kept alive until the loop ends) and the wnd_proc matches the required ABI.
        unsafe {
            let hinstance = GetModuleHandleW(std::ptr::null());
            let mut wc: WNDCLASSW = std::mem::zeroed();
            wc.lpfnWndProc = Some(wnd_proc);
            wc.hInstance = hinstance;
            wc.lpszClassName = class_name.as_ptr();
            if RegisterClassW(&wc) == 0 {
                eprintln!("session_lock: RegisterClassW failed");
                return;
            }
            let hwnd = CreateWindowExW(
                0, class_name.as_ptr(), class_name.as_ptr(), 0, 0, 0, 0, 0,
                HWND_MESSAGE, std::ptr::null_mut(), hinstance, std::ptr::null(),
            );
            if hwnd.is_null() {
                eprintln!("session_lock: CreateWindowExW failed");
                return;
            }
            if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) == 0 {
                eprintln!("session_lock: WTSRegisterSessionNotification failed (Win+L won't lock the vault)");
            }
            let power = RegisterSuspendResumeNotification(hwnd as HANDLE, DEVICE_NOTIFY_WINDOW_HANDLE);
            if (power as isize) == 0 {
                eprintln!("session_lock: RegisterSuspendResumeNotification failed (sleep won't lock the vault)");
            } else {
                POWER_STORE.store(power as isize, Ordering::Release);
            }
            HWND_STORE.store(hwnd as isize, Ordering::Release);

            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            HWND_STORE.store(0, Ordering::Release);
        }
    }

    /// Starts the listener thread and registers a guard that stops it on app teardown.
    pub fn start(app: &AppHandle) {
        use tauri::Manager;
        if APP.set(app.clone()).is_err() {
            return; // already started
        }
        if let Err(e) = std::thread::Builder::new().name("session-lock".into()).spawn(run_loop) {
            eprintln!("session_lock: couldn't start thread: {e}");
            return;
        }
        app.manage(Guard);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_lock_disconnect_suspend() {
        assert_eq!(reason_for(WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK), Some(LockReason::Lock));
        assert_eq!(reason_for(WM_WTSSESSION_CHANGE, WTS_REMOTE_DISCONNECT), Some(LockReason::Disconnect));
        assert_eq!(reason_for(WM_POWERBROADCAST, PBT_APMSUSPEND), Some(LockReason::Suspend));
    }

    #[test]
    fn ignores_everything_else() {
        assert_eq!(reason_for(WM_WTSSESSION_CHANGE, 0x8), None); // unlock
        assert_eq!(reason_for(WM_POWERBROADCAST, 0x0007), None); // resume
        assert_eq!(reason_for(0x0001, WTS_SESSION_LOCK), None);
    }

    #[test]
    fn reason_strings_match_the_frontend_contract() {
        assert_eq!(LockReason::Lock.as_str(), "lock");
        assert_eq!(LockReason::Suspend.as_str(), "suspend");
        assert_eq!(LockReason::Disconnect.as_str(), "disconnect");
    }
}
