//! Portable profile: the user's presentation (display name, accent, bio,
//! avatar/banner images) saved locally so it can be applied to any server
//! on explicit request. Usernames are per-server identities and are never
//! part of it. `profile.json` lives in `{app_config_dir}`; image bytes live
//! in `{app_data_dir}/profile/` with real extensions, because re-upload
//! goes through `upload_attachment`'s file-path branch which derives the
//! multipart filename from the path.
//!
//! It is also who you are on this device when no server is saying: the
//! pictures can be set here directly (`profile_set_image`), and the webview
//! shows them through `writform-att://profile/<avatar|banner>`.

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::commands::api::active_client;
use crate::commands::connect::CmdError;
use crate::servers::ConnectionManager;

/// Largest profile image we'll copy down when saving (matches the server's
/// attachment cap order of magnitude; banners/avatars are far smaller).
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortableProfile {
    pub display_name: Option<String>,
    pub accent_color: Option<String>,
    pub bio: Option<String>,
    /// Absolute paths, ready for `upload_attachment { file_path }`.
    pub avatar_path: Option<String>,
    pub banner_path: Option<String>,
    pub saved_at: i64,
}

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CmdError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| CmdError::new("no_config_dir", e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| CmdError::new("io", e.to_string()))?;
    Ok(dir.join("profile.json"))
}

fn images_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CmdError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::new("no_data_dir", e.to_string()))?
        .join("profile");
    std::fs::create_dir_all(&dir).map_err(|e| CmdError::new("io", e.to_string()))?;
    Ok(dir)
}

fn mime_ext(mime: &str) -> &'static str {
    match mime {
        m if m.contains("png") => "png",
        m if m.contains("jpeg") || m.contains("jpg") => "jpg",
        m if m.contains("gif") => "gif",
        m if m.contains("webp") => "webp",
        m if m.contains("svg") => "svg",
        _ => "img",
    }
}

/// Remove every stored variant of `stem` (stem.png, stem.jpg, …) so a
/// re-save with a different type can't leave a stale twin behind.
fn remove_stem(dir: &std::path::Path, stem: &str) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with(&format!("{stem}.")) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Download one of the caller's current profile attachments over the pinned
/// client and store it as `{stem}.{ext}`; returns the absolute path.
async fn fetch_image(
    manager: &ConnectionManager,
    dir: &std::path::Path,
    stem: &str,
    attachment_id: i64,
) -> Result<String, CmdError> {
    let (client, addr, token) = active_client(manager)?;
    let res = client
        .get(format!("https://{addr}/api/v1/attachments/{attachment_id}"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| CmdError::new("unreachable", format!("image download failed: {e}")))?;
    if res.status().as_u16() >= 400 {
        return Err(CmdError::new(
            "image_download_failed",
            format!("image download failed ({})", res.status()),
        ));
    }
    let ext = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(mime_ext)
        .unwrap_or("img");
    let bytes = res
        .bytes()
        .await
        .map_err(|e| CmdError::new("bad_response", e.to_string()))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(CmdError::new(
            "too_large",
            "profile image is larger than 8 MB",
        ));
    }
    remove_stem(dir, stem);
    let path = dir.join(format!("{stem}.{ext}"));
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| CmdError::new("io", e.to_string()))?;
    Ok(path.display().to_string())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The extension for a picture, from its own first bytes. Only the kinds a
/// server takes as a profile picture and every webview draws.
pub(crate) fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// "avatar" or "banner" — the only two pictures a profile has.
fn image_stem(kind: &str) -> Result<&'static str, CmdError> {
    match kind {
        "avatar" => Ok("avatar"),
        "banner" => Ok("banner"),
        _ => Err(CmdError::new("bad_request", "no such profile picture")),
    }
}

/// Store `bytes` as the profile's avatar or banner in `dir`, replacing any
/// other; returns its path.
pub(crate) fn store_image(
    dir: &std::path::Path,
    stem: &str,
    bytes: &[u8],
) -> Result<std::path::PathBuf, CmdError> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(CmdError::new(
            "too_large",
            "profile image is larger than 8 MB",
        ));
    }
    let ext = image_ext(bytes).ok_or_else(|| {
        CmdError::new(
            "bad_image",
            "That isn't a picture this can use. Choose a PNG, JPEG, GIF or WebP.",
        )
    })?;
    remove_stem(dir, stem);
    let path = dir.join(format!("{stem}.{ext}"));
    crate::localdocs::atomic_write(&path, bytes, false)
        .map_err(|e| CmdError::new("io", e.to_string()))?;
    Ok(path)
}

/// The stored avatar or banner, whatever its type.
pub(crate) fn stored_image(dir: &std::path::Path, stem: &str) -> Option<Vec<u8>> {
    let prefix = format!("{stem}.");
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(&prefix) && !name.ends_with(".tmp")
        })
        .and_then(|entry| std::fs::read(entry.path()).ok())
}

/// For the `writform-att://profile/<avatar|banner>` scheme.
pub fn image_bytes(app: &tauri::AppHandle, kind: &str) -> Option<Vec<u8>> {
    stored_image(&images_dir(app).ok()?, image_stem(kind).ok()?)
}

fn write_profile(app: &tauri::AppHandle, profile: &PortableProfile) -> Result<(), CmdError> {
    let bytes = serde_json::to_vec_pretty(profile)
        .map_err(|e| CmdError::new("serialize_failed", e.to_string()))?;
    crate::localdocs::atomic_write(&config_path(app)?, &bytes, false)
        .map_err(|e| CmdError::new("io", e.to_string()))
}

/// The saved profile, or an empty one to start from.
fn profile_or_new(app: &tauri::AppHandle) -> Result<PortableProfile, CmdError> {
    Ok(profile_get(app.clone())?.unwrap_or(PortableProfile {
        display_name: None,
        accent_color: None,
        bio: None,
        avatar_path: None,
        banner_path: None,
        saved_at: 0,
    }))
}

/// Set the avatar or banner from a picture chosen on this device. The bytes
/// arrive as the raw request body; `x-kind` says which picture.
#[tauri::command]
pub fn profile_set_image(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<PortableProfile, CmdError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CmdError::new("bad_body", "expected raw image bytes"));
    };
    let kind = request
        .headers()
        .get("x-kind")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let stem = image_stem(kind)?;
    let path = store_image(&images_dir(&app)?, stem, bytes)?
        .display()
        .to_string();
    let mut profile = profile_or_new(&app)?;
    if stem == "avatar" {
        profile.avatar_path = Some(path);
    } else {
        profile.banner_path = Some(path);
    }
    profile.saved_at = now_millis();
    write_profile(&app, &profile)?;
    Ok(profile)
}

/// Take the avatar or banner off the profile.
#[tauri::command]
pub fn profile_clear_image(
    app: tauri::AppHandle,
    kind: String,
) -> Result<PortableProfile, CmdError> {
    let stem = image_stem(&kind)?;
    remove_stem(&images_dir(&app)?, stem);
    let mut profile = profile_or_new(&app)?;
    if stem == "avatar" {
        profile.avatar_path = None;
    } else {
        profile.banner_path = None;
    }
    profile.saved_at = now_millis();
    write_profile(&app, &profile)?;
    Ok(profile)
}

#[tauri::command]
pub fn profile_get(app: tauri::AppHandle) -> Result<Option<PortableProfile>, CmdError> {
    let path = config_path(&app)?;
    let Ok(bytes) = std::fs::read(path) else {
        return Ok(None);
    };
    Ok(serde_json::from_slice(&bytes).ok())
}

/// Snapshot the given fields (and the CURRENT server copies of the given
/// attachment ids) as the portable profile. Images first, json last, so a
/// failed download can't leave a profile pointing at missing files.
#[tauri::command]
pub async fn profile_save(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ConnectionManager>,
    display_name: Option<String>,
    accent_color: Option<String>,
    bio: Option<String>,
    avatar_attachment_id: Option<i64>,
    banner_attachment_id: Option<i64>,
) -> Result<PortableProfile, CmdError> {
    let dir = images_dir(&app)?;

    let avatar_path = match avatar_attachment_id {
        Some(id) => Some(fetch_image(&manager, &dir, "avatar", id).await?),
        None => {
            remove_stem(&dir, "avatar");
            None
        }
    };
    let banner_path = match banner_attachment_id {
        Some(id) => Some(fetch_image(&manager, &dir, "banner", id).await?),
        None => {
            remove_stem(&dir, "banner");
            None
        }
    };

    let profile = PortableProfile {
        display_name: display_name.filter(|s| !s.trim().is_empty()),
        accent_color,
        bio: bio.filter(|s| !s.trim().is_empty()),
        avatar_path,
        banner_path,
        saved_at: now_millis(),
    };
    write_profile(&app, &profile)?;
    Ok(profile)
}

/// Update only the text fields of the portable profile, keeping any stored
/// images untouched. Used offline, where the images can't be re-fetched
/// (`profile_save` snapshots them from the connected server).
#[tauri::command]
pub fn profile_update_fields(
    app: tauri::AppHandle,
    display_name: Option<String>,
    accent_color: Option<String>,
    bio: Option<String>,
) -> Result<PortableProfile, CmdError> {
    let existing = profile_get(app.clone())?;
    let profile = PortableProfile {
        display_name: display_name.filter(|s| !s.trim().is_empty()),
        accent_color,
        bio: bio.filter(|s| !s.trim().is_empty()),
        avatar_path: existing.as_ref().and_then(|p| p.avatar_path.clone()),
        banner_path: existing.as_ref().and_then(|p| p.banner_path.clone()),
        saved_at: now_millis(),
    };
    write_profile(&app, &profile)?;
    Ok(profile)
}

#[tauri::command]
pub fn profile_delete(app: tauri::AppHandle) -> Result<(), CmdError> {
    let _ = std::fs::remove_file(config_path(&app)?);
    if let Ok(dir) = images_dir(&app) {
        remove_stem(&dir, "avatar");
        remove_stem(&dir, "banner");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picture_set_on_the_device_replaces_the_one_before() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let png = [0x89, b'P', b'N', b'G', 1, 2, 3];
        let jpg = [0xFF, 0xD8, 0xFF, 9, 9];

        let first = store_image(d, "avatar", &png).unwrap();
        assert!(first.ends_with("avatar.png"));
        assert_eq!(stored_image(d, "avatar").as_deref(), Some(&png[..]));
        assert!(stored_image(d, "banner").is_none());

        // Another type: the old file goes, so there is only ever one.
        let second = store_image(d, "avatar", &jpg).unwrap();
        assert!(second.ends_with("avatar.jpg"));
        assert!(!first.exists());
        assert_eq!(stored_image(d, "avatar").as_deref(), Some(&jpg[..]));

        // Not a picture, or not one of the two: refused, nothing changed.
        assert_eq!(
            store_image(d, "avatar", b"<svg onload=alert(1)>")
                .unwrap_err()
                .code,
            "bad_image"
        );
        assert_eq!(stored_image(d, "avatar").as_deref(), Some(&jpg[..]));
        assert!(image_stem("../avatar").is_err());
        assert!(image_stem("banner").is_ok());

        remove_stem(d, "avatar");
        assert!(stored_image(d, "avatar").is_none());
    }
}
