//! Local-first notes vault: plain Obsidian-compatible `.md` files in
//! `{app_data_dir}/vault/`. All filesystem access lives here in the Rust
//! core; the webview only sees note names and contents.

use serde::Serialize;
use tauri::Manager;

use crate::commands::connect::CmdError;

#[derive(Debug, Clone, Serialize)]
pub struct NoteMeta {
    /// Note name (filename without `.md`).
    pub name: String,
    /// Unix millis mtime.
    pub modified_at: i64,
}

fn vault_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CmdError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError {
            code: "no_data_dir".into(),
            message: e.to_string(),
        })?
        .join("vault");
    std::fs::create_dir_all(&dir).map_err(|e| CmdError {
        code: "io".into(),
        message: e.to_string(),
    })?;
    Ok(dir)
}

/// Note names are plain filenames — no separators, no traversal, no hidden
/// files. Obsidian-compatible.
fn note_path(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, CmdError> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 200
        || name.starts_with('.')
        || name.contains(['/', '\\', ':'])
    {
        return Err(CmdError {
            code: "bad_name".into(),
            message: "invalid note name".into(),
        });
    }
    Ok(vault_dir(app)?.join(format!("{name}.md")))
}

fn io_err(e: std::io::Error) -> CmdError {
    CmdError {
        code: "io".into(),
        message: e.to_string(),
    }
}

#[tauri::command]
pub fn vault_list(app: tauri::AppHandle) -> Result<Vec<NoteMeta>, CmdError> {
    let dir = vault_dir(&app)?;
    let mut notes = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(io_err)? {
        let entry = entry.map_err(io_err)?;
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "md") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                let modified_at = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                notes.push(NoteMeta {
                    name: stem.to_string(),
                    modified_at,
                });
            }
        }
    }
    notes.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(notes)
}

#[tauri::command]
pub fn vault_read(app: tauri::AppHandle, name: String) -> Result<String, CmdError> {
    std::fs::read_to_string(note_path(&app, &name)?).map_err(io_err)
}

#[tauri::command]
pub fn vault_write(app: tauri::AppHandle, name: String, content: String) -> Result<(), CmdError> {
    if content.len() > 4 * 1024 * 1024 {
        return Err(CmdError {
            code: "too_large".into(),
            message: "note is too large".into(),
        });
    }
    std::fs::write(note_path(&app, &name)?, content).map_err(io_err)
}

#[tauri::command]
pub fn vault_delete(app: tauri::AppHandle, name: String) -> Result<(), CmdError> {
    std::fs::remove_file(note_path(&app, &name)?).map_err(io_err)
}

/// Notes whose content links to `name` via `[[name]]` or `[[name|label]]`
/// (case-insensitive, Obsidian semantics).
#[tauri::command]
pub fn vault_backlinks(app: tauri::AppHandle, name: String) -> Result<Vec<String>, CmdError> {
    let target = name.to_lowercase();
    let mut backlinks = Vec::new();
    for note in vault_list(app.clone())? {
        if note.name.to_lowercase() == target {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(note_path(&app, &note.name)?) else {
            continue;
        };
        let links_to_target = extract_wiki_links(&content)
            .iter()
            .any(|l| l.to_lowercase() == target);
        if links_to_target {
            backlinks.push(note.name);
        }
    }
    Ok(backlinks)
}

/// `[[Target]]` / `[[Target|label]]` → `Target`.
pub fn extract_wiki_links(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else { break };
        let inner = &rest[..end];
        // An unclosed `[[` swallows text up to the next real link; restart
        // the scan from the nested opener instead.
        if let Some(nested) = inner.find("[[") {
            rest = &rest[nested..];
            continue;
        }
        let target = inner.split('|').next().unwrap_or(inner).trim();
        if !target.is_empty() && !target.contains('\n') {
            links.push(target.to_string());
        }
        rest = &rest[end + 2..];
    }
    links
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wiki_link_extraction() {
        let content = "See [[Alpha]] and [[Beta|the second one]].\nBroken [[ and [[Gamma]]";
        assert_eq!(extract_wiki_links(content), vec!["Alpha", "Beta", "Gamma"]);
    }
}
