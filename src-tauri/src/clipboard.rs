//! Secret-safe clipboard writes (0.7.0).
//!
//! On Windows the text is published together with the "do not record" formats so
//! it stays out of clipboard history (Win+V) and the cloud clipboard; a timer then
//! wipes it again, but only if it is still what we put there.

pub const FMT_EXCLUDE_MONITOR: &str = "ExcludeClipboardContentFromMonitorProcessing";
pub const FMT_CAN_HISTORY: &str = "CanIncludeInClipboardHistory";
pub const FMT_CAN_CLOUD: &str = "CanUploadToCloudClipboard";

/// UTF-16 code units of `s` followed by a NUL terminator.
#[cfg_attr(not(windows), allow(dead_code))]
fn utf16_with_nul(s: &str) -> Vec<u16> {
    let mut v: Vec<u16> = s.encode_utf16().collect();
    v.push(0);
    v
}

/// Payload of the DWORD-valued formats: a little-endian 0 ("no").
#[cfg_attr(not(windows), allow(dead_code))]
fn dword_zero_bytes() -> [u8; 4] {
    0u32.to_le_bytes()
}

/// NUL-terminated UTF-16 name for RegisterClipboardFormatW.
#[cfg_attr(not(windows), allow(dead_code))]
fn wide_name(s: &str) -> Vec<u16> {
    utf16_with_nul(s)
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW,
        SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    const CF_UNICODETEXT: u32 = 13;
    /// Generation counter: a new copy bumps it, which cancels any pending wipe.
    static GENERATION: AtomicU64 = AtomicU64::new(0);

    struct Clip;
    impl Clip {
        fn open() -> Result<Clip, String> {
            for _ in 0..10 {
                // SAFETY: a null owner window associates the clipboard with the current task.
                if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                    return Ok(Clip);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err("clipboard is busy".into())
        }
    }
    impl Drop for Clip {
        fn drop(&mut self) {
            // SAFETY: only constructed after a successful OpenClipboard on this thread.
            unsafe { CloseClipboard() };
        }
    }

    /// Hands `bytes` to the clipboard as format `fmt`. Clipboard must be open.
    fn set_bytes(fmt: u32, bytes: &[u8]) -> Result<(), String> {
        // SAFETY: plain allocation; checked for null below.
        let h = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)) };
        if h.is_null() {
            return Err("out of memory".into());
        }
        // SAFETY: `h` is a valid movable block of at least bytes.len() bytes; the lock
        // pointer is only written within that length and released right after.
        unsafe {
            let p = GlobalLock(h) as *mut u8;
            if p.is_null() {
                GlobalFree(h);
                return Err("GlobalLock failed".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            GlobalUnlock(h);
        }
        // SAFETY: on success the system owns `h`; on failure we still own and free it.
        unsafe {
            if SetClipboardData(fmt, h as HANDLE).is_null() {
                GlobalFree(h);
                return Err("SetClipboardData failed".into());
            }
        }
        Ok(())
    }

    fn register(name: &str) -> u32 {
        let w = wide_name(name);
        // SAFETY: `w` is NUL-terminated and outlives the call.
        unsafe { RegisterClipboardFormatW(w.as_ptr()) }
    }

    fn to_bytes(w: &[u16]) -> Vec<u8> {
        w.iter().flat_map(|u| u.to_le_bytes()).collect()
    }

    pub fn secure_copy(text: &str, clear_after_ms: u64) -> Result<(), String> {
        let mut wide = utf16_with_nul(text);
        let mut bytes = to_bytes(&wide);
        let res = (|| {
            let _clip = Clip::open()?;
            // SAFETY: clipboard is open.
            if unsafe { EmptyClipboard() } == 0 {
                return Err("EmptyClipboard failed".to_string());
            }
            set_bytes(CF_UNICODETEXT, &bytes)?;
            // Opt-outs are best-effort: the text is already on the clipboard.
            let _ = set_bytes(register(FMT_EXCLUDE_MONITOR), &[1u8]);
            let _ = set_bytes(register(FMT_CAN_HISTORY), &dword_zero_bytes());
            let _ = set_bytes(register(FMT_CAN_CLOUD), &dword_zero_bytes());
            Ok(())
        })();
        for u in wide.iter_mut() {
            *u = 0;
        }
        for b in bytes.iter_mut() {
            *b = 0;
        }
        res?;

        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        if clear_after_ms > 0 {
            let expected = text.to_owned();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(clear_after_ms));
                if GENERATION.load(Ordering::SeqCst) == generation {
                    clear_if_unchanged(&expected);
                }
            });
        }
        Ok(())
    }

    fn current_text() -> Option<Vec<u16>> {
        // SAFETY: called with the clipboard open; the data handle is owned by the
        // clipboard, we lock it, copy up to the NUL and unlock.
        unsafe {
            let h = GetClipboardData(CF_UNICODETEXT);
            if h.is_null() {
                return None;
            }
            let p = GlobalLock(h) as *const u16;
            if p.is_null() {
                return None;
            }
            let mut n = 0usize;
            while *p.add(n) != 0 {
                n += 1;
            }
            let out = std::slice::from_raw_parts(p, n).to_vec();
            GlobalUnlock(h);
            Some(out)
        }
    }

    fn clear_if_unchanged(expected: &str) {
        let Ok(_clip) = Clip::open() else { return };
        let mut want: Vec<u16> = expected.encode_utf16().collect();
        if let Some(mut cur) = current_text() {
            if cur == want {
                // SAFETY: clipboard is open.
                unsafe { EmptyClipboard() };
            }
            for u in cur.iter_mut() {
                *u = 0;
            }
        }
        for u in want.iter_mut() {
            *u = 0;
        }
    }
}

#[tauri::command]
pub fn secure_copy(text: String, clear_after_ms: u64) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::secure_copy(&text, clear_after_ms)
    }
    #[cfg(not(windows))]
    {
        let _ = (text, clear_after_ms);
        Err("unsupported".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_buffer_is_nul_terminated() {
        assert_eq!(utf16_with_nul(""), vec![0]);
        assert_eq!(utf16_with_nul("aB"), vec![97, 66, 0]);
        // surrogate pair for a non-BMP char
        assert_eq!(utf16_with_nul("\u{1F512}"), vec![0xD83D, 0xDD12, 0]);
    }

    #[test]
    fn dword_payload_is_four_zero_bytes() {
        assert_eq!(dword_zero_bytes(), [0, 0, 0, 0]);
    }

    #[test]
    fn format_names_are_exact() {
        assert_eq!(FMT_EXCLUDE_MONITOR, "ExcludeClipboardContentFromMonitorProcessing");
        assert_eq!(FMT_CAN_HISTORY, "CanIncludeInClipboardHistory");
        assert_eq!(FMT_CAN_CLOUD, "CanUploadToCloudClipboard");
        let w = wide_name(FMT_CAN_CLOUD);
        assert_eq!(*w.last().unwrap(), 0);
        assert_eq!(w.len(), FMT_CAN_CLOUD.len() + 1);
    }
}
