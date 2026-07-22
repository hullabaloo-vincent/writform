//! Documents stored on this device: single-user, no server involved. Each
//! doc is one JSON file in `{app_data_dir}/local-documents/{id}.json` whose
//! schema the webview owns (title/format/Yjs state, base64). The Rust core
//! only does validated filesystem access, like the notes vault.

use serde::Serialize;
use tauri::Manager;

use crate::commands::connect::CmdError;

/// Full-state saves of a single-user Yjs doc stay tiny; 16 MB is a
/// generous ceiling that still bounds webview memory.
const MAX_DOC_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct LocalDocMeta {
    pub id: String,
    pub title: String,
    pub format: String,
    /// Unix millis mtime.
    pub updated_at: i64,
}

fn docs_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CmdError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::new("no_data_dir", e.to_string()))?
        .join("local-documents");
    std::fs::create_dir_all(&dir).map_err(|e| CmdError::new("io", e.to_string()))?;
    Ok(dir)
}

/// Ids are client-generated UUIDs — lowercase hex + dashes only, so they
/// are filename-safe by construction and can't traverse.
fn doc_path(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, CmdError> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(CmdError::new("bad_id", "invalid local document id"));
    }
    Ok(docs_dir(app)?.join(format!("{id}.json")))
}

#[tauri::command]
pub fn localdoc_list(app: tauri::AppHandle) -> Result<Vec<LocalDocMeta>, CmdError> {
    let dir = docs_dir(&app)?;
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
        // Meta only — the (potentially large) state stays on disk.
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
        out.push(LocalDocMeta {
            id: id.to_string(),
            title: parsed["title"].as_str().unwrap_or("Untitled").to_string(),
            format: parsed["format"].as_str().unwrap_or("default").to_string(),
            updated_at,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub fn localdoc_read(app: tauri::AppHandle, id: String) -> Result<String, CmdError> {
    std::fs::read_to_string(doc_path(&app, &id)?).map_err(|e| CmdError::new("io", e.to_string()))
}

#[tauri::command]
pub fn localdoc_write(app: tauri::AppHandle, id: String, content: String) -> Result<(), CmdError> {
    if content.len() > MAX_DOC_BYTES {
        return Err(CmdError::new(
            "too_large",
            "local document exceeds the 16 MB limit",
        ));
    }
    std::fs::write(doc_path(&app, &id)?, content).map_err(|e| CmdError::new("io", e.to_string()))
}

#[tauri::command]
pub fn localdoc_delete(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    std::fs::remove_file(doc_path(&app, &id)?).map_err(|e| CmdError::new("io", e.to_string()))
}
