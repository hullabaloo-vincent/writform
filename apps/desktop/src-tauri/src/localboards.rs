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

/// A board a search found: by its name (no snippet), or by the words on it.
#[derive(Debug, Clone, Serialize)]
pub struct LocalBoardHit {
    pub id: String,
    pub snippet: String,
}

/// The kinds of element whose `text` is words. The others keep data there:
/// a picture's id, a link's address, a document card's reference.
const WORDY: [&str; 4] = ["sticky", "text", "shape", "frame"];

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

/// A board's file, or the copy kept from before its last save when the
/// file itself is missing or cut short (a crash mid-save).
fn read_board(path: &std::path::Path) -> std::io::Result<String> {
    let main = std::fs::read_to_string(path);
    if let Ok(text) = &main {
        if serde_json::from_str::<serde_json::Value>(text).is_ok() {
            return main;
        }
    }
    let mut backup = path.as_os_str().to_owned();
    backup.push(".bak");
    match std::fs::read_to_string(std::path::PathBuf::from(backup)) {
        Ok(text) if serde_json::from_str::<serde_json::Value>(&text).is_ok() => Ok(text),
        _ => main,
    }
}

#[tauri::command]
pub fn localboard_read(app: tauri::AppHandle, id: String) -> Result<String, CmdError> {
    read_board(&board_path(&app, &id)?).map_err(|e| CmdError::new("io", e.to_string()))
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
    // Temp file → fsync → rename, keeping the previous save beside it: a
    // crash or a full disk mid-save can never leave half a board.
    crate::localdocs::atomic_write(&board_path(&app, &id)?, content.as_bytes(), true)
        .map_err(|e| CmdError::new("io", e.to_string()))
}

/// The boards with `query` (any case) in their name or in the words on
/// them, with the words around the first match on the board.
pub fn search_boards(dir: &std::path::Path, query: &str) -> Vec<LocalBoardHit> {
    let needle = query.trim().to_lowercase();
    let mut out = Vec::new();
    if needle.is_empty() {
        return out;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if validate_board_id(id).is_err() {
            continue;
        }
        let Ok(raw) = read_board(&path) else {
            continue;
        };
        let Ok(board) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let on_board = board["elements"].as_array().and_then(|elements| {
            elements
                .iter()
                .filter(|el| el["kind"].as_str().is_some_and(|k| WORDY.contains(&k)))
                .filter_map(|el| el["text"].as_str())
                .find_map(|text| crate::vault::snippet_around(text, &needle))
        });
        let named = board["name"]
            .as_str()
            .is_some_and(|name| name.to_lowercase().contains(&needle));
        if on_board.is_some() || named {
            out.push(LocalBoardHit {
                id: id.to_string(),
                snippet: on_board.unwrap_or_default(),
            });
        }
    }
    out
}

#[tauri::command(async)]
pub fn localboard_search(
    app: tauri::AppHandle,
    query: String,
) -> Result<Vec<LocalBoardHit>, CmdError> {
    Ok(search_boards(&boards_dir(&app)?, &query))
}

/// How long a deleted board waits in Recently Deleted.
const TRASH_DAYS: u64 = 30;

fn trash_dir(boards: &std::path::Path) -> std::path::PathBuf {
    boards.join("trash")
}

/// Move a board's file into the trash folder (its pictures stay until the
/// trash lets go of it). The file's modified time becomes "deleted at".
pub fn trash_board(boards: &std::path::Path, id: &str) -> std::io::Result<()> {
    let from = boards.join(format!("{id}.json"));
    let dir = trash_dir(boards);
    std::fs::create_dir_all(&dir)?;
    let to = dir.join(format!("{id}.json"));
    // Read + write rather than rename, so the time on the file is now.
    let bytes = std::fs::read(&from)?;
    std::fs::write(&to, bytes)?;
    std::fs::remove_file(&from)?;
    let _ = std::fs::remove_file(boards.join(format!("{id}.json.bak")));
    Ok(())
}

pub fn restore_board(boards: &std::path::Path, id: &str) -> std::io::Result<()> {
    let from = trash_dir(boards).join(format!("{id}.json"));
    let to = boards.join(format!("{id}.json"));
    if to.exists() {
        return Err(std::io::Error::other("a board with that id already exists"));
    }
    std::fs::rename(from, to)
}

/// Boards in the trash, newest first — dropping (for good) those that have
/// waited out their days.
pub fn list_board_trash(
    boards: &std::path::Path,
    now: std::time::SystemTime,
) -> Vec<LocalBoardMeta> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(trash_dir(boards)) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let deleted = entry.metadata().and_then(|m| m.modified()).ok();
        let age = deleted.and_then(|t| now.duration_since(t).ok());
        if age.is_some_and(|a| a.as_secs() > TRASH_DAYS * 24 * 3600) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        let name = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v["name"].as_str().map(str::to_string))
            .unwrap_or_else(|| "Untitled".to_string());
        out.push(LocalBoardMeta {
            id: id.to_string(),
            name,
            updated_at: deleted
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

/// Deleting a board moves it to Recently Deleted (30 days).
#[tauri::command]
pub fn localboard_delete(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    validate_board_id(&id)?;
    trash_board(&boards_dir(&app)?, &id).map_err(|e| CmdError::new("io", e.to_string()))
}

#[tauri::command]
pub fn localboard_trash_list(app: tauri::AppHandle) -> Result<Vec<LocalBoardMeta>, CmdError> {
    Ok(list_board_trash(
        &boards_dir(&app)?,
        std::time::SystemTime::now(),
    ))
}

#[tauri::command]
pub fn localboard_restore(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    validate_board_id(&id)?;
    restore_board(&boards_dir(&app)?, &id).map_err(|e| CmdError::new("io", e.to_string()))
}

/// Delete a board in the trash for good.
#[tauri::command]
pub fn localboard_purge(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    validate_board_id(&id)?;
    std::fs::remove_file(trash_dir(&boards_dir(&app)?).join(format!("{id}.json")))
        .map_err(|e| CmdError::new("io", e.to_string()))
}

/// The files of the boards in the trash, for the caller that decides which
/// pictures are still in use (a board that can come back keeps its own).
#[tauri::command]
pub fn localboard_trash_read(app: tauri::AppHandle, id: String) -> Result<String, CmdError> {
    validate_board_id(&id)?;
    std::fs::read_to_string(trash_dir(&boards_dir(&app)?).join(format!("{id}.json")))
        .map_err(|e| CmdError::new("io", e.to_string()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deleted_board_waits_in_the_trash_and_comes_back() {
        let dir = tempfile::tempdir().unwrap();
        let boards = dir.path();
        std::fs::write(
            boards.join("7.json"),
            r#"{"name":"Plot wall","elements":[]}"#,
        )
        .unwrap();
        std::fs::write(boards.join("7.json.bak"), "old").unwrap();

        trash_board(boards, "7").unwrap();
        assert!(!boards.join("7.json").exists());
        assert!(!boards.join("7.json.bak").exists());
        let now = std::time::SystemTime::now();
        let listed = list_board_trash(boards, now);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "7");
        assert_eq!(listed[0].name, "Plot wall");

        restore_board(boards, "7").unwrap();
        assert!(boards.join("7.json").exists());
        assert!(list_board_trash(boards, now).is_empty());

        // Restoring never overwrites a board that's there.
        trash_board(boards, "7").unwrap();
        std::fs::write(boards.join("7.json"), "{}").unwrap();
        assert!(restore_board(boards, "7").is_err());
    }

    #[test]
    fn search_finds_boards_by_name_and_by_the_words_on_them() {
        let dir = tempfile::tempdir().unwrap();
        let boards = dir.path();
        std::fs::write(
            boards.join("1.json"),
            r#"{"name":"Plot wall","elements":[
                {"kind":"sticky","text":"The heist goes wrong at the harbour"},
                {"kind":"image","text":"local:harbour-0000"},
                {"kind":"link","text":"https://example.com/harbour"}]}"#,
        )
        .unwrap();
        std::fs::write(
            boards.join("2.json"),
            r#"{"name":"Harbour map","elements":[{"kind":"image","text":"local:abcd"}]}"#,
        )
        .unwrap();
        std::fs::write(
            boards.join("3.json"),
            r#"{"name":"Cast","elements":[{"kind":"link","text":"https://example.com/harbour"}]}"#,
        )
        .unwrap();
        // A deleted board isn't found.
        std::fs::write(
            boards.join("4.json"),
            r#"{"name":"Harbour, old","elements":[]}"#,
        )
        .unwrap();
        trash_board(boards, "4").unwrap();

        let mut found = search_boards(boards, " HARBOUR ");
        found.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(
            found.len(),
            2,
            "a link's address and a picture's id aren't words"
        );
        assert_eq!(found[0].id, "1");
        assert!(found[0].snippet.contains("heist goes wrong"));
        assert_eq!(found[1].id, "2");
        assert_eq!(found[1].snippet, "", "found by its name");
        assert!(search_boards(boards, "").is_empty());
        assert!(search_boards(boards, "zeppelin").is_empty());
    }

    #[test]
    fn the_trash_lets_go_after_thirty_days() {
        let dir = tempfile::tempdir().unwrap();
        let boards = dir.path();
        std::fs::write(boards.join("3.json"), r#"{"name":"Old"}"#).unwrap();
        trash_board(boards, "3").unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(29 * 24 * 3600);
        assert_eq!(list_board_trash(boards, later).len(), 1);
        let much_later =
            std::time::SystemTime::now() + std::time::Duration::from_secs(31 * 24 * 3600);
        assert!(list_board_trash(boards, much_later).is_empty());
        assert!(!boards.join("trash").join("3.json").exists());
    }

    #[test]
    fn a_board_cut_short_reads_from_its_last_good_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("1.json");
        crate::localdocs::atomic_write(&path, br#"{"name":"one"}"#, true).unwrap();
        crate::localdocs::atomic_write(&path, br#"{"name":"two"}"#, true).unwrap();
        assert_eq!(read_board(&path).unwrap(), r#"{"name":"two"}"#);
        // A torn main file: the copy from before the last save stands in.
        std::fs::write(&path, r#"{"name":"tw"#).unwrap();
        assert_eq!(read_board(&path).unwrap(), r#"{"name":"one"}"#);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(read_board(&path).unwrap(), r#"{"name":"one"}"#);
    }
}
