//! Canvas boards stored on this device: single-user, no server involved.
//! Each board is one JSON file in `{app_data_dir}/local-boards/{id}.json`
//! whose schema the webview owns (name/elements/counters). The Rust core only
//! does validated filesystem access, like the notes vault and local documents.

use serde::Serialize;
use tauri::Manager;

use crate::commands::connect::CmdError;

/// Boards hold text, shapes, and attachment references — never image bytes —
/// so 16 MB is a generous ceiling that still bounds webview memory.
const MAX_BOARD_BYTES: usize = 16 * 1024 * 1024;
/// One pasted picture. Generous: these are stored raw, outside the board file.
const MAX_MEDIA_BYTES: usize = 24 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct LocalBoardMeta {
    /// The board's client-side id, as a string (the webview uses negatives to
    /// keep local boards from ever colliding with server board ids).
    pub id: String,
    pub name: String,
    /// Unix millis mtime.
    pub updated_at: i64,
}

fn boards_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CmdError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::new("no_data_dir", e.to_string()))?
        .join("local-boards");
    std::fs::create_dir_all(&dir).map_err(|e| CmdError::new("io", e.to_string()))?;
    Ok(dir)
}

/// Ids are client-generated digit strings, so they are filename-safe by
/// construction and can't traverse.
fn validate_board_id(id: &str) -> Result<(), CmdError> {
    if id.is_empty() || id.len() > 32 || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(CmdError::new("bad_id", "invalid local board id"));
    }
    Ok(())
}

fn board_path(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, CmdError> {
    validate_board_id(id)?;
    Ok(boards_dir(app)?.join(format!("{id}.json")))
}

/// Images pasted onto a board that lives on this device. Stored as raw bytes
/// in `local-boards/media/{id}` — never base64 — and read back through the
/// `writform-att://localboard/{id}` scheme, so the render path is a plain
/// file read with no decoding in between.
///
/// The store is shared by every local board rather than split per board, so
/// copying a picture from one board to another keeps working. Files no board
/// references any more are swept up by `localmedia_prune`.
fn media_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CmdError> {
    Ok(boards_dir(app)?.join("media"))
}

fn media_path(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, CmdError> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(CmdError::new("bad_id", "invalid media id"));
    }
    Ok(media_dir(app)?.join(id))
}

/// Bytes for the custom URI scheme; `None` for anything that isn't a real
/// media file.
pub fn media_bytes(app: &tauri::AppHandle, id: &str) -> Option<Vec<u8>> {
    std::fs::read(media_path(app, id).ok()?).ok()
}

#[tauri::command]
pub fn localboard_list(app: tauri::AppHandle) -> Result<Vec<LocalBoardMeta>, CmdError> {
    let dir = boards_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| CmdError::new("io", e.to_string()))? {
        let entry = entry.map_err(|e| CmdError::new("io", e.to_string()))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        // Meta only — the (potentially large) element list stays on disk.
        let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let updated_at = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(LocalBoardMeta {
            id: id.to_string(),
            name: parsed["name"].as_str().unwrap_or("Untitled").to_string(),
            updated_at,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub fn localboard_read(app: tauri::AppHandle, id: String) -> Result<String, CmdError> {
    std::fs::read_to_string(board_path(&app, &id)?).map_err(|e| CmdError::new("io", e.to_string()))
}

#[tauri::command]
pub fn localboard_write(
    app: tauri::AppHandle,
    id: String,
    content: String,
) -> Result<(), CmdError> {
    if content.len() > MAX_BOARD_BYTES {
        return Err(CmdError::new(
            "too_large",
            "local board exceeds the 16 MB limit",
        ));
    }
    std::fs::write(board_path(&app, &id)?, content).map_err(|e| CmdError::new("io", e.to_string()))
}

#[tauri::command]
pub fn localboard_delete(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    std::fs::remove_file(board_path(&app, &id)?).map_err(|e| CmdError::new("io", e.to_string()))
}

/// Delete every stored picture that no board mentions any more. The caller
/// gathers the ids still in use — it is the side that can read the boards.
#[tauri::command]
pub fn localmedia_prune(app: tauri::AppHandle, keep: Vec<String>) -> Result<(), CmdError> {
    let dir = media_dir(&app)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(()); // nothing stored yet
    };
    let keep: std::collections::HashSet<&str> = keep.iter().map(String::as_str).collect();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !keep.contains(name) {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Store one pasted image. The bytes arrive as a RAW ipc body rather than
/// base64: encoding a photo would inflate it by a third and push megabytes of
/// JSON through the bridge for no gain, since it is written to disk verbatim.
#[tauri::command]
pub fn localmedia_write(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), CmdError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CmdError::new("bad_body", "expected raw image bytes"));
    };
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err(CmdError::new("too_large", "image exceeds the 24 MB limit"));
    }
    let id = request
        .headers()
        .get("x-media")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| CmdError::new("bad_request", "missing media id"))?
        .to_string();
    let path = media_path(&app, &id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| CmdError::new("io", e.to_string()))?;
    }
    std::fs::write(path, bytes).map_err(|e| CmdError::new("io", e.to_string()))
}
