//! The files and folders copied in the system's file explorer (Ctrl+C there), so the remote file manager can
//! upload them on Ctrl+V. Windows keeps them on the clipboard as a file list (`CF_HDROP`); the web view can't
//! read that, and the clipboard plugin only handles text.
//!
//! Other systems return an empty list for now (drag and drop and the Upload button still work there).

/// Full paths of the files and folders on the clipboard, or an empty list when it holds something else.
#[tauri::command]
pub fn clipboard_files() -> Vec<String> {
    files()
}

#[cfg(windows)]
fn files() -> Vec<String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard};
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    /// The clipboard format of a list of files (`CF_HDROP`).
    const CF_HDROP: u32 = 15;

    // SAFETY: the clipboard is opened for this thread only and closed before returning; `DragQueryFileW` is given
    // the handle the clipboard owns (valid until `CloseClipboard`) and buffers of the length it asked for.
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP) == 0 || OpenClipboard(std::ptr::null_mut()) == 0 {
            return Vec::new();
        }
        let mut out = Vec::new();
        let handle = GetClipboardData(CF_HDROP);
        if !handle.is_null() {
            let drop = handle as HDROP;
            let count = DragQueryFileW(drop, 0xFFFF_FFFF, std::ptr::null_mut(), 0);
            for i in 0..count {
                let len = DragQueryFileW(drop, i, std::ptr::null_mut(), 0) as usize;
                let mut buf = vec![0u16; len + 1];
                let got = DragQueryFileW(drop, i, buf.as_mut_ptr(), buf.len() as u32) as usize;
                out.push(String::from_utf16_lossy(&buf[..got.min(len)]));
            }
        }
        CloseClipboard();
        out
    }
}

#[cfg(not(windows))]
fn files() -> Vec<String> {
    Vec::new()
}
