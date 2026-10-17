//! Local-first notes vault: plain Obsidian-compatible `.md` files in
//! `{app_data_dir}/vault/`. All filesystem access lives here in the Rust
//! core; the webview only sees note names and contents.
//!
//! Notes may sit in folders, which are real directories, as in Obsidian. A
//! note is named by its path in the vault without `.md`, its folders joined
//! by `/`: "Ideas", "Victoria Falls/Characters". A folder is named the same
//! way. Dot-folders (`.trash`, `.obsidian`) are never notes or folders.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::commands::connect::CmdError;

#[derive(Debug, Clone, Serialize)]
pub struct NoteMeta {
    /// Note name: its path in the vault without `.md` ("Folder/Note").
    pub name: String,
    /// Unix millis mtime.
    pub modified_at: i64,
}

/// How deep folders go (a note's path has at most this many parts).
const MAX_DEPTH: usize = 10;
/// One part of a path (a folder's or a note's own name), bytes.
const PART_MAX: usize = 200;

fn vault_dir(app: &tauri::AppHandle) -> Result<PathBuf, CmdError> {
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

fn bad_name() -> CmdError {
    CmdError {
        code: "bad_name".into(),
        message: "invalid note or folder name".into(),
    }
}

/// The parts of a note's or a folder's path: no empty part, none starting
/// with a dot (so no `..` and no hidden files), no `\` or `:`, no control
/// characters. Obsidian-compatible. `root` lets "" stand for the vault.
fn path_parts(name: &str, root: bool) -> Result<Vec<String>, CmdError> {
    let name = name.trim().trim_matches('/');
    if name.is_empty() {
        return if root {
            Ok(Vec::new())
        } else {
            Err(bad_name())
        };
    }
    if name.len() > PART_MAX * MAX_DEPTH {
        return Err(bad_name());
    }
    let parts: Vec<String> = name.split('/').map(|p| p.trim().to_string()).collect();
    if parts.len() > MAX_DEPTH {
        return Err(bad_name());
    }
    for part in &parts {
        if part.is_empty()
            || part.len() > PART_MAX
            || part.starts_with('.')
            || part.contains(['\\', ':'])
            || part.chars().any(char::is_control)
        {
            return Err(bad_name());
        }
    }
    Ok(parts)
}

/// A note's file, relative to the vault.
fn note_rel(name: &str) -> Result<PathBuf, CmdError> {
    let parts = path_parts(name, false)?;
    let (last, folders) = parts.split_last().ok_or_else(bad_name)?;
    let mut rel: PathBuf = folders.iter().collect();
    rel.push(format!("{last}.md"));
    Ok(rel)
}

/// A folder, relative to the vault ("" is the vault itself).
fn folder_rel(folder: &str) -> Result<PathBuf, CmdError> {
    Ok(path_parts(folder, true)?.iter().collect())
}

/// A name as the vault writes it: its parts trimmed, joined by `/`.
fn clean(name: &str, root: bool) -> Result<String, CmdError> {
    Ok(path_parts(name, root)?.join("/"))
}

fn note_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, CmdError> {
    Ok(vault_dir(app)?.join(note_rel(name)?))
}

/// The folder a note or folder is in ("" for the top of the vault).
pub fn parent_of(name: &str) -> &str {
    name.rfind('/').map_or("", |i| &name[..i])
}

/// A note's own name, without its folders.
pub fn base_of(name: &str) -> &str {
    name.rfind('/').map_or(name, |i| &name[i + 1..])
}

fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

fn io_err(e: std::io::Error) -> CmdError {
    CmdError {
        code: "io".into(),
        message: e.to_string(),
    }
}

fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Every note (newest first) and every folder (by name) in the vault.
/// Links and dot-folders are passed over, and anything named in a way the
/// vault can't name is left out.
pub fn walk_vault(vault: &Path) -> (Vec<NoteMeta>, Vec<String>) {
    fn go(
        dir: &Path,
        prefix: &str,
        depth: usize,
        notes: &mut Vec<NoteMeta>,
        folders: &mut Vec<String>,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            if file.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                let rel = join(prefix, &file);
                // (A folder as deep as a path goes could hold no note.)
                if depth + 1 >= MAX_DEPTH || path_parts(&rel, false).is_err() {
                    continue;
                }
                folders.push(rel.clone());
                go(&entry.path(), &rel, depth + 1, notes, folders);
            } else if kind.is_file() {
                let Some(stem) = file.strip_suffix(".md") else {
                    continue;
                };
                let name = join(prefix, stem);
                if path_parts(&name, false).is_err() {
                    continue;
                }
                let modified_at = entry.metadata().map(|m| modified_ms(&m)).unwrap_or(0);
                notes.push(NoteMeta { name, modified_at });
            }
        }
    }
    let mut notes = Vec::new();
    let mut folders = Vec::new();
    go(vault, "", 0, &mut notes, &mut folders);
    notes.sort_by_key(|a| std::cmp::Reverse(a.modified_at));
    folders.sort_by_key(|f| f.to_lowercase());
    (notes, folders)
}

#[tauri::command]
pub fn vault_list(app: tauri::AppHandle) -> Result<Vec<NoteMeta>, CmdError> {
    Ok(walk_vault(&vault_dir(&app)?).0)
}

/// Every folder in the vault, empty ones too ("Book", "Book/Chapters").
#[tauri::command]
pub fn vault_folders(app: tauri::AppHandle) -> Result<Vec<String>, CmdError> {
    Ok(walk_vault(&vault_dir(&app)?).1)
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
    // Temp file → fsync → rename: a crash or a full disk mid-save leaves
    // the note as it was, never half-written. No backup file beside it —
    // the vault is the user's own folder of plain files. (Its folder is
    // made if it isn't there.)
    crate::localdocs::atomic_write(&note_path(&app, &name)?, content.as_bytes(), false)
        .map_err(io_err)
}

/// A name no note has: `name`, else "name 2", "name 3"… in its own folder.
pub fn free_note_name(vault: &Path, name: &str) -> String {
    let taken = |candidate: &str| note_rel(candidate).is_ok_and(|rel| vault.join(rel).exists());
    if !taken(name) {
        return name.to_string();
    }
    (2..10_000)
        .map(|n| format!("{name} {n}"))
        .find(|candidate| !taken(candidate))
        .unwrap_or_else(|| name.to_string())
}

/// A name no folder (and no file) has: `name`, else "name 2"…
fn free_folder_name(vault: &Path, name: &str) -> String {
    let taken = |candidate: &str| folder_rel(candidate).is_ok_and(|rel| vault.join(rel).exists());
    if !taken(name) {
        return name.to_string();
    }
    (2..10_000)
        .map(|n| format!("{name} {n}"))
        .find(|candidate| !taken(candidate))
        .unwrap_or_else(|| name.to_string())
}

/// Save as a NEW note: never over one that's there. Returns the name used
/// (a note someone shared with you mustn't replace your own of that name).
#[tauri::command]
pub fn vault_write_new(
    app: tauri::AppHandle,
    name: String,
    content: String,
) -> Result<String, CmdError> {
    let name = clean(&name, false)?;
    let free = free_note_name(&vault_dir(&app)?, &name);
    vault_write(app, free.clone(), content)?;
    Ok(free)
}

/// How long a deleted note waits in the vault's trash.
const TRASH_DAYS: u64 = 30;

fn trash_dir(vault: &Path) -> PathBuf {
    // Hidden, so other Markdown apps reading the folder don't list it.
    vault.join(".trash")
}

fn to_io(e: CmdError) -> std::io::Error {
    std::io::Error::other(e.message)
}

/// Move a note into the vault's trash, in the folders it was in. A note of
/// the same name already there is replaced (the newer deletion is the one
/// to undo).
pub fn trash_note(vault: &Path, name: &str) -> std::io::Result<()> {
    let rel = note_rel(name).map_err(to_io)?;
    let from = vault.join(&rel);
    let to = trash_dir(vault).join(&rel);
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Written anew (not moved), so its days in the trash count from now.
    let bytes = std::fs::read(&from)?;
    std::fs::write(&to, bytes)?;
    std::fs::remove_file(from)
}

/// Put a trashed note back where it was (its folder made again if it has
/// gone). If a note of that name has appeared since, the restored one takes
/// a free name; returns the name it has.
pub fn restore_note(vault: &Path, name: &str) -> std::io::Result<String> {
    let name = clean(name, false).map_err(to_io)?;
    let from = trash_dir(vault).join(note_rel(&name).map_err(to_io)?);
    let free = free_note_name(vault, &name);
    let to = vault.join(note_rel(&free).map_err(to_io)?);
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(from, to)?;
    Ok(free)
}

/// Drop trashed notes (and whatever a trashed folder held) that have waited
/// out their days, and the folders left empty.
pub fn sweep_note_trash(vault: &Path, now: std::time::SystemTime) {
    fn go(dir: &Path, now: std::time::SystemTime) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        let mut empty = true;
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                empty = false;
                continue;
            };
            if kind.is_dir() {
                if go(&path, now) {
                    let _ = std::fs::remove_dir(&path);
                } else {
                    empty = false;
                }
                continue;
            }
            let age = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok());
            if age.is_some_and(|a| a.as_secs() > TRASH_DAYS * 24 * 3600) {
                if std::fs::remove_file(&path).is_err() {
                    empty = false;
                }
            } else {
                empty = false;
            }
        }
        empty
    }
    go(&trash_dir(vault), now);
}

/// Deleting a note moves it to the vault's trash, where it waits 30 days.
#[tauri::command]
pub fn vault_delete(app: tauri::AppHandle, name: String) -> Result<(), CmdError> {
    let name = clean(&name, false)?;
    let dir = vault_dir(&app)?;
    sweep_note_trash(&dir, std::time::SystemTime::now());
    trash_note(&dir, &name).map_err(io_err)
}

/// Undo a delete. Returns the note's name (changed if one of that name has
/// been made since).
#[tauri::command]
pub fn vault_restore(app: tauri::AppHandle, name: String) -> Result<String, CmdError> {
    restore_note(&vault_dir(&app)?, &name).map_err(io_err)
}

// ------------------------------------------------------------ folders

/// Make a folder (and the folders it is in). Returns its name.
#[tauri::command]
pub fn vault_folder_create(app: tauri::AppHandle, path: String) -> Result<String, CmdError> {
    let name = clean(&path, false)?;
    if name.split('/').count() >= MAX_DEPTH {
        return Err(bad_name());
    }
    let dir = vault_dir(&app)?.join(folder_rel(&name)?);
    if dir.exists() {
        return Err(CmdError {
            code: "name_taken".into(),
            message: format!("there is already a folder named \"{}\"", base_of(&name)),
        });
    }
    std::fs::create_dir_all(dir).map_err(io_err)?;
    Ok(name)
}

/// Rename a folder, or move it into another (`new_path` is its whole new
/// path). Links that name notes by their path are pointed at the new one.
/// Returns its new name.
#[tauri::command]
pub fn vault_folder_rename(
    app: tauri::AppHandle,
    path: String,
    new_path: String,
) -> Result<String, CmdError> {
    let vault = vault_dir(&app)?;
    let old = clean(&path, false)?;
    let new = clean(&new_path, false)?;
    move_folder(&vault, &old, &new)?;
    Ok(new)
}

fn move_folder(vault: &Path, old: &str, new: &str) -> Result<(), CmdError> {
    let from = vault.join(folder_rel(old)?);
    let to = vault.join(folder_rel(new)?);
    if !from.is_dir() {
        return Err(CmdError {
            code: "not_found".into(),
            message: "that folder isn't there".into(),
        });
    }
    let (old_lower, new_lower) = (old.to_lowercase(), new.to_lowercase());
    if new_lower.starts_with(&format!("{old_lower}/")) {
        return Err(CmdError {
            code: "bad_name".into(),
            message: "a folder can't go inside itself".into(),
        });
    }
    let depth = walk_vault(&from)
        .1
        .iter()
        .map(|f| f.split('/').count())
        .max()
        .unwrap_or(0);
    if new.split('/').count() + depth >= MAX_DEPTH {
        return Err(bad_name());
    }
    // (Changing only its capitals is the same folder on most disks.)
    if old_lower != new_lower && to.exists() {
        return Err(CmdError {
            code: "name_taken".into(),
            message: format!("there is already a folder named \"{}\"", base_of(new)),
        });
    }
    let before: Vec<String> = walk_vault(vault).0.into_iter().map(|n| n.name).collect();
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(io_err)?;
    }
    std::fs::rename(&from, &to).map_err(io_err)?;
    // Every note in it has a new path.
    let prefix = format!("{old_lower}/");
    let moved: Vec<(String, String)> = before
        .iter()
        .filter(|n| n.to_lowercase().starts_with(&prefix))
        .map(|n| (n.clone(), format!("{new}/{}", &n[old.len() + 1..])))
        .collect();
    repoint_links(vault, &before, &moved).map_err(io_err)
}

/// Delete a folder: it goes to the vault's trash with everything in it,
/// where it waits 30 days.
#[tauri::command]
pub fn vault_folder_delete(app: tauri::AppHandle, path: String) -> Result<(), CmdError> {
    let vault = vault_dir(&app)?;
    let name = clean(&path, false)?;
    sweep_note_trash(&vault, std::time::SystemTime::now());
    trash_folder(&vault, &name).map_err(io_err)
}

pub fn trash_folder(vault: &Path, name: &str) -> std::io::Result<()> {
    let rel = folder_rel(name).map_err(to_io)?;
    let from = vault.join(&rel);
    let to = trash_dir(vault).join(&rel);
    if to.exists() {
        std::fs::remove_dir_all(&to)?;
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from, &to)?;
    // Its days in the trash count from now, whatever the files' own ages.
    touch_all(&to, std::time::SystemTime::now());
    Ok(())
}

fn touch_all(dir: &Path, now: std::time::SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => touch_all(&entry.path(), now),
            Ok(kind) if kind.is_file() => {
                if let Ok(file) = std::fs::File::options().write(true).open(entry.path()) {
                    let _ = file.set_modified(now);
                }
            }
            _ => {}
        }
    }
}

/// Undo a folder's delete. Returns its name (changed if one of that name
/// has been made since).
#[tauri::command]
pub fn vault_folder_restore(app: tauri::AppHandle, path: String) -> Result<String, CmdError> {
    restore_folder(&vault_dir(&app)?, &path).map_err(io_err)
}

pub fn restore_folder(vault: &Path, name: &str) -> std::io::Result<String> {
    let name = clean(name, false).map_err(to_io)?;
    let from = trash_dir(vault).join(folder_rel(&name).map_err(to_io)?);
    let free = free_folder_name(vault, &name);
    let to = vault.join(folder_rel(&free).map_err(to_io)?);
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(from, to)?;
    Ok(free)
}

/// Move a note into a folder ("" is the top of the vault). It keeps its
/// name unless the folder has a note of that name already. Links to it
/// keep leading to it. Returns its new name.
#[tauri::command]
pub fn vault_move(app: tauri::AppHandle, name: String, folder: String) -> Result<String, CmdError> {
    let vault = vault_dir(&app)?;
    let old = clean(&name, false)?;
    let folder = clean(&folder, true)?;
    let target = join(&folder, base_of(&old));
    if target.to_lowercase() == old.to_lowercase() {
        return Ok(old);
    }
    let new = free_note_name(&vault, &target);
    move_note(&vault, &old, &new)?;
    Ok(new)
}

fn move_note(vault: &Path, old: &str, new: &str) -> Result<(), CmdError> {
    let from = vault.join(note_rel(old)?);
    let to = vault.join(note_rel(new)?);
    let before: Vec<String> = walk_vault(vault).0.into_iter().map(|n| n.name).collect();
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(io_err)?;
    }
    if from != to {
        std::fs::rename(&from, &to).map_err(io_err)?;
    }
    repoint_links(vault, &before, &[(old.to_string(), new.to_string())]).map_err(io_err)
}

/// Absolute path of the vault folder, for reveal-in-file-manager.
#[tauri::command]
pub fn vault_path(app: tauri::AppHandle) -> Result<String, CmdError> {
    Ok(vault_dir(&app)?.to_string_lossy().into_owned())
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub name: String,
    /// Text around the first content match; empty for name-only matches.
    pub snippet: String,
    pub modified_at: i64,
}

/// Case-insensitive substring search over note names AND contents, in every
/// folder. Name matches rank first; results cap at 50.
#[tauri::command]
pub fn vault_search(app: tauri::AppHandle, query: String) -> Result<Vec<SearchHit>, CmdError> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let vault = vault_dir(&app)?;
    let mut name_hits = Vec::new();
    let mut content_hits = Vec::new();
    for note in walk_vault(&vault).0 {
        if name_hits.len() + content_hits.len() >= 50 {
            break;
        }
        if note.name.to_lowercase().contains(&needle) {
            name_hits.push(SearchHit {
                name: note.name,
                snippet: String::new(),
                modified_at: note.modified_at,
            });
            continue;
        }
        let Ok(content) = std::fs::read_to_string(vault.join(note_rel(&note.name)?)) else {
            continue;
        };
        if let Some(snippet) = snippet_around(&content, &needle) {
            content_hits.push(SearchHit {
                name: note.name,
                snippet,
                modified_at: note.modified_at,
            });
        }
    }
    name_hits.extend(content_hits);
    Ok(name_hits)
}

/// ~40 chars of context either side of the first case-insensitive match,
/// clamped to char boundaries and flattened to one line.
pub(crate) fn snippet_around(content: &str, needle_lower: &str) -> Option<String> {
    let lower = content.to_lowercase();
    let pos = lower.find(needle_lower)?;
    // Byte offsets in `lower` can differ from `content` under non-ASCII
    // case folding; clamp to the nearest boundaries in the original.
    let mut start = pos.saturating_sub(40);
    while start > 0 && !content.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (pos + needle_lower.len() + 40).min(content.len());
    while end < content.len() && !content.is_char_boundary(end) {
        end += 1;
    }
    if start > content.len() || start >= end {
        return Some(String::new());
    }
    let mut s = content[start..end]
        .replace(['\n', '\r'], " ")
        .trim()
        .to_string();
    if start > 0 {
        s = format!("…{s}");
    }
    if end < content.len() {
        s.push('…');
    }
    Some(s)
}

/// Renames a note (`new_name` is its whole new path, so this moves it too)
/// and points every link that led to it at it again, so the backlink graph
/// survives. Returns the name actually used.
#[tauri::command]
pub fn vault_rename(
    app: tauri::AppHandle,
    name: String,
    new_name: String,
) -> Result<String, CmdError> {
    let vault = vault_dir(&app)?;
    let old = clean(&name, false)?;
    let new = clean(&new_name, false)?;
    // A case-only rename ("notes" → "Notes") targets the same file on
    // case-insensitive filesystems, so `exists` there is not a collision.
    if !old.eq_ignore_ascii_case(&new) && vault.join(note_rel(&new)?).exists() {
        return Err(CmdError {
            code: "name_taken".into(),
            message: format!("a note named \"{}\" already exists", base_of(&new)),
        });
    }
    move_note(&vault, &old, &new)?;
    Ok(new)
}

/// The note a link leads to, as Obsidian finds it. A link with a `/` names
/// a path. A bare name finds the note of that name in the linking note's
/// own folder, else the one with the shortest path (then the first by
/// name). Case is not minded.
pub fn resolve_link<'a>(names: &'a [String], link: &str, from: &str) -> Option<&'a str> {
    let link = link.trim().trim_matches('/');
    let link = link.strip_suffix(".md").unwrap_or(link).to_lowercase();
    if link.is_empty() {
        return None;
    }
    if link.contains('/') {
        return names
            .iter()
            .find(|n| n.to_lowercase() == link)
            .map(String::as_str);
    }
    let here = parent_of(from).to_lowercase();
    let mut best: Option<&str> = None;
    for name in names {
        if base_of(name).to_lowercase() != link {
            continue;
        }
        if parent_of(name).to_lowercase() == here {
            return Some(name);
        }
        let better = best.is_none_or(|b| {
            let (depth, b_depth) = (name.split('/').count(), b.split('/').count());
            depth < b_depth || (depth == b_depth && name.to_lowercase() < b.to_lowercase())
        });
        if better {
            best = Some(name);
        }
    }
    best
}

/// After notes moved (`moved`: old and new names), every link in the vault
/// that led to one leads to it again. A bare name stays a bare name while
/// that still finds the note, otherwise the link says its path.
fn repoint_links(
    vault: &Path,
    before: &[String],
    moved: &[(String, String)],
) -> std::io::Result<()> {
    if moved.is_empty() {
        return Ok(());
    }
    let after: Vec<String> = walk_vault(vault).0.into_iter().map(|n| n.name).collect();
    let new_of = |old: &str| {
        moved
            .iter()
            .find(|(o, _)| o == old)
            .map(|(_, n)| n.as_str())
    };
    let old_of = |new: &str| {
        moved
            .iter()
            .find(|(_, n)| n == new)
            .map(|(o, _)| o.as_str())
    };
    for note in &after {
        let was = old_of(note).unwrap_or(note);
        let path = vault.join(note_rel(note).map_err(to_io)?);
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let rewritten = rewrite_links(&content, |target| {
            let led = resolve_link(before, target, was)?;
            let new = new_of(led)?;
            let bare = base_of(new);
            if !target.contains('/') && resolve_link(&after, bare, note) == Some(new) {
                Some(bare.to_string())
            } else {
                Some(new.to_string())
            }
        });
        if rewritten != content {
            crate::localdocs::atomic_write(&path, rewritten.as_bytes(), false)?;
        }
    }
    Ok(())
}

/// Notes whose content links to `name` (by its name or its path, with or
/// without a label, case-insensitive, Obsidian semantics).
#[tauri::command]
pub fn vault_backlinks(app: tauri::AppHandle, name: String) -> Result<Vec<String>, CmdError> {
    let vault = vault_dir(&app)?;
    let name = clean(&name, false)?;
    let names: Vec<String> = walk_vault(&vault).0.into_iter().map(|n| n.name).collect();
    let Some(target) = names
        .iter()
        .find(|n| n.eq_ignore_ascii_case(&name))
        .cloned()
    else {
        return Ok(Vec::new());
    };
    let mut backlinks = Vec::new();
    for note in &names {
        if *note == target {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(vault.join(note_rel(note)?)) else {
            continue;
        };
        let links_to_target = extract_wiki_links(&content)
            .iter()
            .any(|l| resolve_link(&names, l, note) == Some(target.as_str()));
        if links_to_target {
            backlinks.push(note.clone());
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

/// Repoints `[[old]]` / `[[old|label]]` at `new`, matching the target
/// case-insensitively like [`extract_wiki_links`]. Labels and every other
/// link are left untouched.
pub fn rewrite_wiki_links(content: &str, old: &str, new: &str) -> String {
    let target = old.trim().to_lowercase();
    rewrite_links(content, |link| {
        (link.trim().to_lowercase() == target).then(|| new.to_string())
    })
}

/// Every `[[link]]` whose target `to` gives a new one for is written with
/// it (its label kept). The rest of the text is left exactly as it was.
fn rewrite_links(content: &str, to: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        let Some(end) = rest[start + 2..].find("]]") else {
            break;
        };
        let inner = &rest[start + 2..start + 2 + end];
        // An unclosed `[[` swallows text up to the next real link; restart the
        // scan from the nested opener, same as extract_wiki_links.
        if let Some(nested) = inner.find("[[") {
            let resume = start + 2 + nested;
            out.push_str(&rest[..resume]);
            rest = &rest[resume..];
            continue;
        }
        out.push_str(&rest[..start]);
        let (link, label) = match inner.split_once('|') {
            Some((link, label)) => (link, Some(label)),
            None => (inner, None),
        };
        match (to(link.trim()), label) {
            (Some(new), Some(label)) => out.push_str(&format!("[[{new}|{label}]]")),
            (Some(new), None) => out.push_str(&format!("[[{new}]]")),
            (None, _) => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &rest[start + 2 + end + 2..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deleted_note_waits_in_the_trash_and_comes_back() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        std::fs::write(vault.join("Ideas.md"), "first draft").unwrap();

        trash_note(vault, "Ideas").unwrap();
        assert!(!vault.join("Ideas.md").exists());
        assert_eq!(
            std::fs::read_to_string(vault.join(".trash").join("Ideas.md")).unwrap(),
            "first draft"
        );
        assert_eq!(restore_note(vault, "Ideas").unwrap(), "Ideas");
        assert_eq!(
            std::fs::read_to_string(vault.join("Ideas.md")).unwrap(),
            "first draft"
        );

        // A note of the same name made in the meantime is never replaced.
        trash_note(vault, "Ideas").unwrap();
        std::fs::write(vault.join("Ideas.md"), "a new note").unwrap();
        assert_eq!(restore_note(vault, "Ideas").unwrap(), "Ideas 2");
        assert_eq!(
            std::fs::read_to_string(vault.join("Ideas.md")).unwrap(),
            "a new note"
        );
        assert_eq!(
            std::fs::read_to_string(vault.join("Ideas 2.md")).unwrap(),
            "first draft"
        );
    }

    #[test]
    fn the_note_trash_lets_go_after_thirty_days() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        std::fs::write(vault.join("Old.md"), "x").unwrap();
        trash_note(vault, "Old").unwrap();
        let now = std::time::SystemTime::now();
        sweep_note_trash(vault, now + std::time::Duration::from_secs(29 * 24 * 3600));
        assert!(vault.join(".trash").join("Old.md").exists());
        sweep_note_trash(vault, now + std::time::Duration::from_secs(31 * 24 * 3600));
        assert!(!vault.join(".trash").join("Old.md").exists());
    }

    #[test]
    fn saving_as_new_never_takes_a_name_in_use() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        assert_eq!(free_note_name(vault, "Shared"), "Shared");
        std::fs::write(vault.join("Shared.md"), "mine").unwrap();
        assert_eq!(free_note_name(vault, "Shared"), "Shared 2");
        std::fs::write(vault.join("Shared 2.md"), "also mine").unwrap();
        assert_eq!(free_note_name(vault, "Shared"), "Shared 3");
    }

    #[test]
    fn wiki_link_extraction() {
        let content = "See [[Alpha]] and [[Beta|the second one]].\nBroken [[ and [[Gamma]]";
        assert_eq!(extract_wiki_links(content), vec!["Alpha", "Beta", "Gamma"]);
    }

    #[test]
    fn wiki_link_rewrite_preserves_labels_and_other_links() {
        let content = "See [[Alpha]], [[alpha|the first]] and [[Beta]].";
        assert_eq!(
            rewrite_wiki_links(content, "Alpha", "Project Alpha"),
            "See [[Project Alpha]], [[Project Alpha|the first]] and [[Beta]].",
        );
    }

    #[test]
    fn wiki_link_rewrite_leaves_unrelated_content_alone() {
        let content = "No links here, just [brackets] and [[Gamma]].";
        assert_eq!(rewrite_wiki_links(content, "Alpha", "Beta"), content);
    }

    #[test]
    fn wiki_link_rewrite_survives_unclosed_opener() {
        let content = "Broken [[ and [[Alpha]] after it";
        assert_eq!(
            rewrite_wiki_links(content, "Alpha", "Beta"),
            "Broken [[ and [[Beta]] after it",
        );
    }

    #[test]
    fn snippet_finds_case_insensitive_match_with_context() {
        let content = "Alpha beta GAMMA delta epsilon";
        let s = snippet_around(content, "gamma").unwrap();
        assert!(s.contains("GAMMA"), "{s}");
        assert!(s.contains("beta") && s.contains("delta"));
    }

    #[test]
    fn snippet_flattens_newlines_and_marks_truncation() {
        let long = format!("{}needle{}", "x".repeat(100), "y\ny".repeat(60));
        let s = snippet_around(&long, "needle").unwrap();
        assert!(s.starts_with('…') && s.ends_with('…'), "{s}");
        assert!(!s.contains('\n'));
    }

    #[test]
    fn snippet_survives_multibyte_boundaries() {
        let content = format!("{}né needle {}", "é".repeat(30), "ü".repeat(30));
        let s = snippet_around(&content, "needle").unwrap();
        assert!(s.contains("needle"));
    }

    #[test]
    fn snippet_none_without_match() {
        assert!(snippet_around("nothing here", "absent").is_none());
    }

    fn write(vault: &Path, rel: &str, text: &str) {
        let path = vault.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn names_are_paths_and_nothing_climbs_out() {
        assert_eq!(
            clean(" Book / Chapters /Ideas ", false).unwrap(),
            "Book/Chapters/Ideas"
        );
        for bad in [
            "",
            "..",
            "Book/../x",
            "/",
            ".hidden",
            "Book/.trash/x",
            "a\\b",
            "c:d",
            "a//b",
        ] {
            assert!(clean(bad, false).is_err(), "{bad}");
        }
        assert_eq!(clean("", true).unwrap(), "");
        let deep = ["d"; MAX_DEPTH + 1].join("/");
        assert!(clean(&deep, false).is_err());
        assert_eq!(
            note_rel("Book/Ideas").unwrap(),
            Path::new("Book").join("Ideas.md")
        );
    }

    #[test]
    fn the_vault_is_walked_into_its_folders_but_not_its_hidden_ones() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write(vault, "Top.md", "");
        write(vault, "Book/Chapter.md", "");
        write(vault, "Book/Cast/Ana.md", "");
        write(vault, ".trash/Gone.md", "");
        write(vault, ".obsidian/workspace.md", "");
        write(vault, "Book/picture.png", "");
        std::fs::create_dir_all(vault.join("Empty")).unwrap();
        let (notes, folders) = walk_vault(vault);
        let mut names: Vec<String> = notes.into_iter().map(|n| n.name).collect();
        names.sort();
        assert_eq!(names, vec!["Book/Cast/Ana", "Book/Chapter", "Top"]);
        assert_eq!(folders, vec!["Book", "Book/Cast", "Empty"]);
    }

    #[test]
    fn a_bare_link_finds_the_nearest_note_of_its_name() {
        let names: Vec<String> = ["Ideas", "Book/Ideas", "Book/Cast/Ana", "Other/Ana", "Ana"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            resolve_link(&names, "ideas", "Book/Chapter"),
            Some("Book/Ideas")
        );
        assert_eq!(resolve_link(&names, "Ideas", "Top"), Some("Ideas"));
        assert_eq!(resolve_link(&names, "Ana", "Book/Chapter"), Some("Ana"));
        assert_eq!(resolve_link(&names, "Ana", "Other/Note"), Some("Other/Ana"));
        assert_eq!(
            resolve_link(&names, "book/cast/ana", "Top"),
            Some("Book/Cast/Ana")
        );
        assert_eq!(resolve_link(&names, "Book/Missing", "Top"), None);
    }

    #[test]
    fn moving_a_note_keeps_every_link_to_it() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write(vault, "Ideas.md", "x");
        write(vault, "Plan.md", "See [[Ideas]] and [[Ideas|the list]].");
        write(vault, "Book/Ideas.md", "the book's own");
        write(vault, "Book/Chapter.md", "Mine: [[Ideas]]. Top: [[Plan]].");
        // Into a folder that has a note of the same name: it takes a free one,
        // and the links that led to it now name it.
        let new = free_note_name(vault, "Book/Ideas");
        assert_eq!(new, "Book/Ideas 2");
        move_note(vault, "Ideas", &new).unwrap();
        assert_eq!(
            std::fs::read_to_string(vault.join("Plan.md")).unwrap(),
            "See [[Ideas 2]] and [[Ideas 2|the list]]."
        );
        assert_eq!(
            std::fs::read_to_string(vault.join("Book/Chapter.md")).unwrap(),
            "Mine: [[Ideas]]. Top: [[Plan]].",
            "a link to the book's own note is left alone"
        );
        // Moving a folder: path links follow it.
        write(vault, "Index.md", "[[Book/Chapter]] and [[Chapter]]");
        move_folder(vault, "Book", "Series/Book").unwrap();
        assert!(vault.join("Series/Book/Chapter.md").exists());
        assert_eq!(
            std::fs::read_to_string(vault.join("Index.md")).unwrap(),
            "[[Series/Book/Chapter]] and [[Chapter]]"
        );
        assert!(move_folder(vault, "Series", "Series/Book/Inside").is_err());
    }

    #[test]
    fn a_deleted_folder_waits_in_the_trash_and_comes_back() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write(vault, "Book/Chapter.md", "one");
        write(vault, "Book/Cast/Ana.md", "two");
        trash_folder(vault, "Book").unwrap();
        assert!(!vault.join("Book").exists());
        assert!(vault.join(".trash/Book/Cast/Ana.md").exists());
        // Its days count from the delete.
        sweep_note_trash(
            vault,
            std::time::SystemTime::now() + std::time::Duration::from_secs(29 * 24 * 3600),
        );
        assert!(vault.join(".trash/Book/Chapter.md").exists());
        std::fs::create_dir_all(vault.join("Book")).unwrap();
        assert_eq!(restore_folder(vault, "Book").unwrap(), "Book 2");
        assert_eq!(
            std::fs::read_to_string(vault.join("Book 2/Cast/Ana.md")).unwrap(),
            "two"
        );
        // A note in a folder goes to the trash in its folder, and back.
        trash_note(vault, "Book 2/Chapter").unwrap();
        assert!(vault.join(".trash/Book 2/Chapter.md").exists());
        std::fs::remove_dir_all(vault.join("Book 2")).unwrap();
        assert_eq!(
            restore_note(vault, "Book 2/Chapter").unwrap(),
            "Book 2/Chapter"
        );
        assert_eq!(
            std::fs::read_to_string(vault.join("Book 2/Chapter.md")).unwrap(),
            "one"
        );
        // Emptied folders in the trash go too.
        trash_note(vault, "Book 2/Chapter").unwrap();
        sweep_note_trash(
            vault,
            std::time::SystemTime::now() + std::time::Duration::from_secs(31 * 24 * 3600),
        );
        assert!(!vault.join(".trash/Book 2").exists());
    }
}
