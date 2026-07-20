//! Microphone authorization.
//!
//! On macOS a WKWebView will not raise the system microphone prompt on its
//! own: `getUserMedia` is denied silently unless the *app* already holds TCC
//! authorization, so on a fresh install voice appears to do nothing at all.
//! Asking AVFoundation directly puts the real prompt on screen and records
//! the grant, after which the webview's capture succeeds.
//!
//! Other platforms have no equivalent gate — the browser engine prompts — so
//! they report `authorized` and let `getUserMedia` do the asking.

/// Authorization state, mirroring `AVAuthorizationStatus`.
/// One of: `not_determined`, `restricted`, `denied`, `authorized`.
pub type AuthStatus = &'static str;

#[cfg(target_os = "macos")]
mod imp {
    use super::AuthStatus;

    // `AVMediaTypeAudio` is the four-character code "soun"; using the literal
    // avoids linking the AVFoundation constant just to read one string.
    const MEDIA_TYPE_AUDIO: &str = "soun";

    fn status_name(raw: isize) -> AuthStatus {
        match raw {
            0 => "not_determined",
            1 => "restricted",
            2 => "denied",
            3 => "authorized",
            _ => "unknown",
        }
    }

    pub fn status() -> AuthStatus {
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;
        let media_type = NSString::from_str(MEDIA_TYPE_AUDIO);
        let raw: isize = unsafe {
            msg_send![
                class!(AVCaptureDevice),
                authorizationStatusForMediaType: &*media_type
            ]
        };
        status_name(raw)
    }

    /// Show the system prompt when the state is still undecided, and wait for
    /// the answer. Already-decided states return immediately — macOS only
    /// ever prompts once, after which the user must use System Settings.
    pub fn request() -> AuthStatus {
        if status() != "not_determined" {
            return status();
        }
        use block2::RcBlock;
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;

        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let handler = RcBlock::new(move |granted: objc2::runtime::Bool| {
            let _ = tx.send(granted.as_bool());
        });
        let media_type = NSString::from_str(MEDIA_TYPE_AUDIO);
        unsafe {
            let _: () = msg_send![
                class!(AVCaptureDevice),
                requestAccessForMediaType: &*media_type,
                completionHandler: &*handler
            ];
        }
        // The prompt is modal to the user, not to us; wait generously, but
        // never hang the command forever if the callback is lost.
        match rx.recv_timeout(std::time::Duration::from_secs(120)) {
            Ok(true) => "authorized",
            Ok(false) => "denied",
            Err(_) => status(),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::AuthStatus;
    pub fn status() -> AuthStatus {
        "authorized"
    }
    pub fn request() -> AuthStatus {
        "authorized"
    }
}

/// Current microphone authorization, without prompting.
#[tauri::command]
pub fn microphone_status() -> AuthStatus {
    imp::status()
}

/// Prompt for microphone access if the user has not decided yet.
#[tauri::command]
pub async fn request_microphone_access() -> AuthStatus {
    tauri::async_runtime::spawn_blocking(imp::request)
        .await
        .unwrap_or("unknown")
}
