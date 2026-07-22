//! Microphone and camera authorization.
//!
//! On macOS a WKWebView will not raise the system capture prompts on its
//! own: `getUserMedia` is denied silently unless the *app* already holds TCC
//! authorization, so on a fresh install voice/video appear to do nothing at
//! all. Asking AVFoundation directly puts the real prompt on screen and
//! records the grant, after which the webview's capture succeeds.
//!
//! Other platforms have no equivalent gate — the browser engine prompts — so
//! they report `authorized` and let `getUserMedia` do the asking.

/// Authorization state, mirroring `AVAuthorizationStatus`.
/// One of: `not_determined`, `restricted`, `denied`, `authorized`.
pub type AuthStatus = &'static str;

#[cfg(target_os = "macos")]
mod imp {
    use super::AuthStatus;

    // `AVMediaTypeAudio`/`AVMediaTypeVideo` are the four-character codes
    // "soun"/"vide"; using the literals avoids linking the AVFoundation
    // constants just to read one string each.
    pub const MEDIA_TYPE_AUDIO: &str = "soun";
    pub const MEDIA_TYPE_VIDEO: &str = "vide";

    fn status_name(raw: isize) -> AuthStatus {
        match raw {
            0 => "not_determined",
            1 => "restricted",
            2 => "denied",
            3 => "authorized",
            _ => "unknown",
        }
    }

    pub fn status(media_type: &str) -> AuthStatus {
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;
        let media_type = NSString::from_str(media_type);
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
    pub fn request(media_type: &str) -> AuthStatus {
        if status(media_type) != "not_determined" {
            return status(media_type);
        }
        use block2::RcBlock;
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;

        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let handler = RcBlock::new(move |granted: objc2::runtime::Bool| {
            let _ = tx.send(granted.as_bool());
        });
        let ns_media_type = NSString::from_str(media_type);
        unsafe {
            let _: () = msg_send![
                class!(AVCaptureDevice),
                requestAccessForMediaType: &*ns_media_type,
                completionHandler: &*handler
            ];
        }
        // The prompt is modal to the user, not to us; wait generously, but
        // never hang the command forever if the callback is lost.
        match rx.recv_timeout(std::time::Duration::from_secs(120)) {
            Ok(true) => "authorized",
            Ok(false) => "denied",
            Err(_) => status(media_type),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::AuthStatus;
    pub const MEDIA_TYPE_AUDIO: &str = "soun";
    pub const MEDIA_TYPE_VIDEO: &str = "vide";
    pub fn status(_media_type: &str) -> AuthStatus {
        "authorized"
    }
    pub fn request(_media_type: &str) -> AuthStatus {
        "authorized"
    }
}

/// Current microphone authorization, without prompting.
#[tauri::command]
pub fn microphone_status() -> AuthStatus {
    imp::status(imp::MEDIA_TYPE_AUDIO)
}

/// Prompt for microphone access if the user has not decided yet.
#[tauri::command]
pub async fn request_microphone_access() -> AuthStatus {
    tauri::async_runtime::spawn_blocking(|| imp::request(imp::MEDIA_TYPE_AUDIO))
        .await
        .unwrap_or("unknown")
}

/// Current camera authorization, without prompting.
#[tauri::command]
pub fn camera_status() -> AuthStatus {
    imp::status(imp::MEDIA_TYPE_VIDEO)
}

/// Prompt for camera access if the user has not decided yet.
#[tauri::command]
pub async fn request_camera_access() -> AuthStatus {
    tauri::async_runtime::spawn_blocking(|| imp::request(imp::MEDIA_TYPE_VIDEO))
        .await
        .unwrap_or("unknown")
}
