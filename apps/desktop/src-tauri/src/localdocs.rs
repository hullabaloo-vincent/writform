//! Documents stored on this device: single-user, no server involved. Each
//! doc is one JSON file in `{app_data_dir}/local-documents/{id}.json` whose
//! schema the webview owns (title/format/Yjs state, base64). The Rust core
//! only does validated filesystem access, like the notes vault.
//!
//! Writes are atomic (temp file → fsync → rename) and keep the previous copy
//! as `{id}.json.bak`, so a crash mid-save can never leave a writer with a
//! truncated manuscript; reads fall back to the backup. Every command runs
//! off the main thread (`async`), so a large save never stalls the UI.
//!
//! Beside each document the webview keeps a small `meta/{id}.json` (title,
//! format, word count, opening words) so the organizer can list documents
//! without reading whole manuscripts. Deleting moves a document — with its
//! history and notes — into `.trash/{id}/` for 30 days (Recently Deleted).
//!
//! Two more things the webview keeps here: `text/{id}.txt`, each document's
//! plain text, which is what a search reads (the document itself is Yjs
//! state the core can't see into); and `folders.json`, the folders and which
//! document is in which.

use serde::Serialize;
use tauri::Manager;

use crate::commands::connect::CmdError;

/// Full-state saves of a single-user Yjs doc stay tiny; 16 MB is a
/// generous ceiling that still bounds webview memory.
const MAX_DOC_BYTES: usize = 16 * 1024 * 1024;
/// One compressed history version (a whole novel compresses to ~1 MB).
const MAX_VERSION_BYTES: usize = 16 * 1024 * 1024;
/// The list metadata beside a document is a few hundred bytes.
const MAX_META_BYTES: usize = 64 * 1024;
/// Recently Deleted keeps a document this long.
const TRASH_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const TRASH_DIR: &str = ".trash";
/// Pictures in on-device documents: `media/{doc id}/{picture id}`, the raw
/// bytes as they were added. A document's pictures travel with it — into
/// Recently Deleted and back, and away for good when it is.
const MEDIA_DIR: &str = "media";
/// One picture.
const MAX_MEDIA_BYTES: usize = 24 * 1024 * 1024;
/// A document's plain text, for searching.
const TEXT_DIR: &str = "text";
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
/// The folders, and which document is in which (JSON the webview owns).
const FOLDERS_FILE: &str = "folders.json";
const MAX_FOLDERS_BYTES: usize = 1024 * 1024;
/// A search stops collecting matches here.
const MAX_SEARCH_HITS: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct LocalDocMeta {
    pub id: String,
    pub title: String,
    pub format: String,
    /// Unix millis mtime.
    pub updated_at: i64,
    /// From the metadata saved beside the document (0 / empty until the
    /// document is saved by a version that writes it).
    pub words: i64,
    pub excerpt: String,
    /// What its card shows (synopsis, cover, tags), as the webview wrote it
    /// in the metadata. The webview checks it on reading.
    pub card: Option<serde_json::Value>,
}

/// One document a search found: the words around the first match.
#[derive(Debug, Clone, Serialize)]
pub struct LocalSearchHit {
    pub id: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct LocalSearch {
    pub hits: Vec<LocalSearchHit>,
    /// Documents whose text hasn't been written since they last changed
    /// (or ever): the webview writes it and asks again.
    pub stale: Vec<String>,
}

/// A document in Recently Deleted.
#[derive(Debug, Clone, Serialize)]
pub struct LocalTrashItem {
    pub id: String,
    pub title: String,
    pub format: String,
    pub deleted_at: i64,
    pub words: i64,
    pub excerpt: String,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_millis(path: &std::path::Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// Title, format, words and excerpt from a metadata file, when present.
fn read_meta(path: &std::path::Path) -> Option<serde_json::Value> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn io_err(e: std::io::Error) -> CmdError {
    CmdError::new("io", e.to_string())
}

fn docs_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CmdError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::new("no_data_dir", e.to_string()))?
        .join("local-documents");
    std::fs::create_dir_all(&dir).map_err(io_err)?;
    Ok(dir)
}

/// Ids are client-generated UUIDs — lowercase hex + dashes only, so they
/// are filename-safe by construction and can't traverse.
fn validate_id(id: &str) -> Result<(), CmdError> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(CmdError::new("bad_id", "invalid local document id"));
    }
    Ok(())
}

fn doc_path(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, CmdError> {
    validate_id(id)?;
    Ok(docs_dir(app)?.join(format!("{id}.json")))
}

fn with_suffix(path: &std::path::Path, suffix: &str) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    std::path::PathBuf::from(name)
}

/// Rename, retrying briefly: on Windows a virus scanner or indexer holding
/// the file open makes a rename fail with a sharing violation for a moment.
fn rename_retrying(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    let mut last = None;
    for attempt in 0..5 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(20 * (attempt + 1)));
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

/// Replace `path` with `bytes` atomically, keeping the previous copy as
/// `path.bak` when `keep_backup`.
pub(crate) fn atomic_write(
    path: &std::path::Path,
    bytes: &[u8],
    keep_backup: bool,
) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = with_suffix(path, ".tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    if keep_backup && path.exists() {
        rename_retrying(path, &with_suffix(path, ".bak"))?;
    }
    rename_retrying(&tmp, path)
}

/// Read `path`, or its `.bak` when the main file is missing (a crash between
/// the two renames of an atomic write).
pub(crate) fn read_with_backup(path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::read(with_suffix(path, ".bak")).map_err(|_| e)
        }
        Err(e) => Err(e),
    }
}

/// Legacy single-file history (v1); read once to migrate, then retired.
fn legacy_history_path(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, CmdError> {
    validate_id(id)?;
    let dir = docs_dir(app)?.join("history");
    std::fs::create_dir_all(&dir).map_err(io_err)?;
    Ok(dir.join(format!("{id}.json")))
}

/// History v2: `history/{id}/index.json` plus one compressed file per
/// version. Lives under the documents folder so a folder backup carries the
/// revisions along with the text; `localdoc_list` only reads top-level files.
fn history_dir(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, CmdError> {
    validate_id(id)?;
    Ok(docs_dir(app)?.join("history").join(id))
}

#[tauri::command(async)]
pub fn localdoc_list(app: tauri::AppHandle) -> Result<Vec<LocalDocMeta>, CmdError> {
    let dir = docs_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(io_err)? {
        let entry = entry.map_err(io_err)?;
        let mut path = entry.path();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        // A crash between an atomic write's two renames leaves only the
        // backup: put it back so the document reappears.
        if let Some(stem) = name.strip_suffix(".json.bak") {
            let main = dir.join(format!("{stem}.json"));
            if main.exists() || validate_id(stem).is_err() {
                continue;
            }
            if std::fs::rename(&path, &main).is_err() {
                continue;
            }
            path = main;
        } else if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if validate_id(&id).is_err() {
            continue;
        }
        let updated_at = mtime_millis(&path).unwrap_or(0);
        // The metadata file is written right after each save; when it's at
        // least as new as the document, it's all the list needs.
        let meta_path = dir.join("meta").join(format!("{id}.json"));
        let meta = read_meta(&meta_path);
        let fresh = meta.is_some() && mtime_millis(&meta_path).unwrap_or(0) + 2000 >= updated_at;
        let (title, format) = match (&meta, fresh) {
            (Some(m), true) => (
                m["title"].as_str().unwrap_or("Untitled").to_string(),
                m["format"].as_str().unwrap_or("none").to_string(),
            ),
            _ => {
                let Ok(bytes) = std::fs::read(&path) else {
                    continue;
                };
                let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                    continue;
                };
                (
                    parsed["title"].as_str().unwrap_or("Untitled").to_string(),
                    parsed["format"].as_str().unwrap_or("none").to_string(),
                )
            }
        };
        out.push(LocalDocMeta {
            id,
            title,
            format,
            updated_at,
            words: meta.as_ref().and_then(|m| m["words"].as_i64()).unwrap_or(0),
            excerpt: meta
                .as_ref()
                .and_then(|m| m["excerpt"].as_str())
                .unwrap_or("")
                .to_string(),
            card: meta
                .as_ref()
                .map(|m| m["card"].clone())
                .filter(|c| c.is_object()),
        });
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
    Ok(out)
}

#[tauri::command(async)]
pub fn localdoc_read(app: tauri::AppHandle, id: String) -> Result<String, CmdError> {
    let bytes = read_with_backup(&doc_path(&app, &id)?).map_err(io_err)?;
    String::from_utf8(bytes).map_err(|_| CmdError::new("corrupt", "document file is not text"))
}

/// Save a document; `meta` (title, format, words, excerpt — JSON the webview
/// owns) is written beside it for the organizer's list, and `text` (its
/// plain text, when the webview has just worked it out) for searching.
#[tauri::command(async)]
pub fn localdoc_write(
    app: tauri::AppHandle,
    id: String,
    content: String,
    meta: Option<String>,
    text: Option<String>,
) -> Result<(), CmdError> {
    if content.len() > MAX_DOC_BYTES {
        return Err(CmdError::new(
            "too_large",
            "local document exceeds the 16 MB limit",
        ));
    }
    let path = doc_path(&app, &id)?;
    atomic_write(&path, content.as_bytes(), true).map_err(io_err)?;
    if let Some(meta) = meta.filter(|m| m.len() <= MAX_META_BYTES) {
        if serde_json::from_str::<serde_json::Value>(&meta).is_ok() {
            // The list falls back to the document itself if this fails.
            let _ = atomic_write(
                &docs_dir(&app)?.join("meta").join(format!("{id}.json")),
                meta.as_bytes(),
                false,
            );
        }
    }
    if let Some(text) = text {
        // Search falls back to asking for it again if this fails.
        let _ = write_text_in(&docs_dir(&app)?, &id, &text);
    }
    Ok(())
}

/// Feedback threads (notes-to-self) live beside history, same rationale:
/// a folder backup carries them, and `localdoc_list` never sees the folder.
fn feedback_path(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, CmdError> {
    validate_id(id)?;
    let dir = docs_dir(app)?.join("feedback");
    std::fs::create_dir_all(&dir).map_err(io_err)?;
    Ok(dir.join(format!("{id}.json")))
}

#[tauri::command(async)]
pub fn localdoc_delete(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    // History and feedback are derived data: a failure to remove them must
    // not leave the caller thinking the document survived.
    if let Ok(path) = legacy_history_path(&app, &id) {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(with_suffix(&path, ".v1.bak"));
    }
    if let Ok(dir) = history_dir(&app, &id) {
        let _ = std::fs::remove_dir_all(dir);
    }
    if let Ok(path) = feedback_path(&app, &id) {
        let _ = std::fs::remove_file(path);
    }
    let _ = std::fs::remove_file(docs_dir(&app)?.join("meta").join(format!("{id}.json")));
    let _ = std::fs::remove_file(text_file(&docs_dir(&app)?, &id));
    let _ = std::fs::remove_dir_all(docs_dir(&app)?.join(MEDIA_DIR).join(&id));
    let path = doc_path(&app, &id)?;
    let _ = std::fs::remove_file(with_suffix(&path, ".bak"));
    std::fs::remove_file(path).map_err(io_err)
}

// ---------------------------------------------------------------- pictures

fn media_file(dir: &std::path::Path, doc: &str, media: &str) -> std::path::PathBuf {
    dir.join(MEDIA_DIR).join(doc).join(media)
}

/// A picture's bytes. Looked for under the document named first; a copy of
/// a document keeps the addresses its original wrote, so failing that, under
/// any document (picture ids are unique). `None` when there is no such file.
pub(crate) fn media_bytes_in(dir: &std::path::Path, doc: &str, media: &str) -> Option<Vec<u8>> {
    if validate_id(doc).is_err() || validate_id(media).is_err() {
        return None;
    }
    if let Ok(bytes) = std::fs::read(media_file(dir, doc, media)) {
        return Some(bytes);
    }
    let entries = std::fs::read_dir(dir.join(MEDIA_DIR)).ok()?;
    for entry in entries.flatten() {
        if let Ok(bytes) = std::fs::read(entry.path().join(media)) {
            return Some(bytes);
        }
    }
    None
}

/// For the `writform-att://localdoc/<doc>/<picture>` scheme.
pub fn media_bytes(app: &tauri::AppHandle, rest: &str) -> Option<Vec<u8>> {
    let (doc, media) = rest.split_once('/')?;
    media_bytes_in(&docs_dir(app).ok()?, doc, media)
}

/// Give a copy of a document its own copies of the original's pictures, so
/// it keeps them when the original is deleted.
pub(crate) fn copy_media_in(dir: &std::path::Path, from: &str, to: &str) -> std::io::Result<()> {
    let source = dir.join(MEDIA_DIR).join(from);
    let Ok(entries) = std::fs::read_dir(&source) else {
        return Ok(());
    };
    let dest = dir.join(MEDIA_DIR).join(to);
    std::fs::create_dir_all(&dest)?;
    for entry in entries.flatten() {
        if entry.path().is_file() {
            std::fs::copy(entry.path(), dest.join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// Store one picture for a document. The bytes arrive as the raw request
/// body (base64 would inflate a photo by a third for no gain).
#[tauri::command]
pub fn localdoc_media_write(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), CmdError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CmdError::new("bad_body", "expected raw image bytes"));
    };
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err(CmdError::new("too_large", "image exceeds the 24 MB limit"));
    }
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| CmdError::new("bad_request", "missing id"))
    };
    let doc = header("x-doc")?;
    let media = header("x-media")?;
    validate_id(&doc)?;
    validate_id(&media)?;
    atomic_write(&media_file(&docs_dir(&app)?, &doc, &media), bytes, false).map_err(io_err)
}

#[tauri::command(async)]
pub fn localdoc_media_copy(
    app: tauri::AppHandle,
    from: String,
    to: String,
) -> Result<(), CmdError> {
    validate_id(&from)?;
    validate_id(&to)?;
    copy_media_in(&docs_dir(&app)?, &from, &to).map_err(io_err)
}

// ---------------------------------------------------------------- search

fn text_file(dir: &std::path::Path, id: &str) -> std::path::PathBuf {
    dir.join(TEXT_DIR).join(format!("{id}.txt"))
}

/// Keep a document's plain text for searching. Text past the limit isn't
/// kept at all (a search then finds the document by its title only).
pub(crate) fn write_text_in(dir: &std::path::Path, id: &str, text: &str) -> std::io::Result<()> {
    if text.len() > MAX_TEXT_BYTES {
        return Ok(());
    }
    atomic_write(&text_file(dir, id), text.as_bytes(), false)
}

/// The documents whose text holds `query` (any case), newest first, each
/// with the words around its first match — and the ones whose text is
/// missing or older than the document, which the caller brings up to date.
pub(crate) fn search_in(dir: &std::path::Path, query: &str) -> std::io::Result<LocalSearch> {
    let needle = query.trim().to_lowercase();
    let mut out = LocalSearch::default();
    if needle.is_empty() {
        return Ok(out);
    }
    let mut docs = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if validate_id(&id).is_err() {
            continue;
        }
        docs.push((mtime_millis(&path).unwrap_or(0), id));
    }
    docs.sort_by_key(|a| std::cmp::Reverse(a.0));
    for (updated_at, id) in docs {
        let path = text_file(dir, &id);
        // Written with the document, so never meaningfully older than it.
        let fresh = mtime_millis(&path).is_some_and(|at| at + 2000 >= updated_at);
        if !fresh {
            out.stale.push(id.clone());
        }
        if out.hits.len() >= MAX_SEARCH_HITS {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(snippet) = crate::vault::snippet_around(&text, &needle) {
            out.hits.push(LocalSearchHit { id, snippet });
        }
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn localdoc_search(app: tauri::AppHandle, query: String) -> Result<LocalSearch, CmdError> {
    search_in(&docs_dir(&app)?, &query).map_err(io_err)
}

/// A document's plain text on its own (bringing an older document's up to
/// date for a search).
#[tauri::command(async)]
pub fn localdoc_text_write(
    app: tauri::AppHandle,
    id: String,
    text: String,
) -> Result<(), CmdError> {
    validate_id(&id)?;
    let dir = docs_dir(&app)?;
    if !dir.join(format!("{id}.json")).exists() {
        return Err(CmdError::new("not_found", "no such document"));
    }
    write_text_in(&dir, &id, &text).map_err(io_err)
}

// ---------------------------------------------------------------- folders

/// The folders file, as the JSON the webview wrote; empty when there are no
/// folders yet.
#[tauri::command(async)]
pub fn localdoc_folders_read(app: tauri::AppHandle) -> Result<String, CmdError> {
    match read_with_backup(&docs_dir(&app)?.join(FOLDERS_FILE)) {
        Ok(bytes) => String::from_utf8(bytes)
            .map_err(|_| CmdError::new("corrupt", "folders file is not text")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(io_err(e)),
    }
}

#[tauri::command(async)]
pub fn localdoc_folders_write(app: tauri::AppHandle, content: String) -> Result<(), CmdError> {
    if content.len() > MAX_FOLDERS_BYTES {
        return Err(CmdError::new("too_large", "too many folders"));
    }
    if serde_json::from_str::<serde_json::Value>(&content).is_err() {
        return Err(CmdError::new("bad_request", "folders must be JSON"));
    }
    atomic_write(
        &docs_dir(&app)?.join(FOLDERS_FILE),
        content.as_bytes(),
        true,
    )
    .map_err(io_err)
}

// ---------------------------------------------------------------- recently deleted

/// Move a file or folder if it exists.
fn move_if_exists(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    if !from.exists() {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    rename_retrying(from, to)
}

/// Where a document's pieces live, and where they go in its trash folder.
fn trash_moves(dir: &std::path::Path, id: &str) -> Vec<(std::path::PathBuf, &'static str)> {
    let doc = dir.join(format!("{id}.json"));
    let legacy = dir.join("history").join(format!("{id}.json"));
    vec![
        (doc.clone(), "doc.json"),
        (with_suffix(&doc, ".bak"), "doc.json.bak"),
        (dir.join("meta").join(format!("{id}.json")), "meta.json"),
        (
            dir.join("feedback").join(format!("{id}.json")),
            "feedback.json",
        ),
        (dir.join("history").join(id), "history"),
        (dir.join(MEDIA_DIR).join(id), "media"),
        (text_file(dir, id), "text.txt"),
        (legacy.clone(), "history-v1.json"),
        (with_suffix(&legacy, ".v1.bak"), "history-v1.json.bak"),
    ]
}

/// Move a document, its history and its notes into Recently Deleted.
pub(crate) fn trash_in(dir: &std::path::Path, id: &str, now: i64) -> std::io::Result<()> {
    let doc = dir.join(format!("{id}.json"));
    if !doc.exists() && !with_suffix(&doc, ".bak").exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no such document",
        ));
    }
    let dest = dir.join(TRASH_DIR).join(id);
    std::fs::create_dir_all(&dest)?;
    for (from, name) in trash_moves(dir, id) {
        move_if_exists(&from, &dest.join(name))?;
    }
    atomic_write(
        &dest.join("trashed.json"),
        format!("{{\"deleted_at\":{now}}}").as_bytes(),
        false,
    )
}

/// Put a document back where it was.
pub(crate) fn restore_in(dir: &std::path::Path, id: &str) -> std::io::Result<()> {
    let src = dir.join(TRASH_DIR).join(id);
    if !src.join("doc.json").exists() && !src.join("doc.json.bak").exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not in Recently Deleted",
        ));
    }
    if dir.join(format!("{id}.json")).exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "a document with this id exists",
        ));
    }
    for (to, name) in trash_moves(dir, id) {
        move_if_exists(&src.join(name), &to)?;
    }
    std::fs::remove_dir_all(&src)
}

/// Recently Deleted, newest first; documents past the retention period are
/// deleted for good on the way.
pub(crate) fn trash_list_in(
    dir: &std::path::Path,
    now: i64,
) -> std::io::Result<Vec<LocalTrashItem>> {
    let root = dir.join(TRASH_DIR);
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let Some(id) = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if !path.is_dir() || validate_id(&id).is_err() {
            continue;
        }
        let deleted_at = read_meta(&path.join("trashed.json"))
            .and_then(|v| v["deleted_at"].as_i64())
            .or_else(|| mtime_millis(&path))
            .unwrap_or(now);
        if now - deleted_at > TRASH_RETENTION_MS {
            let _ = std::fs::remove_dir_all(&path);
            continue;
        }
        let meta = read_meta(&path.join("meta.json"));
        let doc = meta.clone().or_else(|| {
            read_with_backup(&path.join("doc.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
        });
        out.push(LocalTrashItem {
            id,
            title: doc
                .as_ref()
                .and_then(|d| d["title"].as_str())
                .unwrap_or("Untitled")
                .to_string(),
            format: doc
                .as_ref()
                .and_then(|d| d["format"].as_str())
                .unwrap_or("none")
                .to_string(),
            deleted_at,
            words: meta.as_ref().and_then(|m| m["words"].as_i64()).unwrap_or(0),
            excerpt: meta
                .as_ref()
                .and_then(|m| m["excerpt"].as_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.deleted_at));
    Ok(out)
}

pub(crate) fn purge_in(dir: &std::path::Path, id: &str) -> std::io::Result<()> {
    match std::fs::remove_dir_all(dir.join(TRASH_DIR).join(id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

pub(crate) fn empty_trash_in(dir: &std::path::Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(dir.join(TRASH_DIR)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[tauri::command(async)]
pub fn localdoc_trash(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    validate_id(&id)?;
    trash_in(&docs_dir(&app)?, &id, now_millis()).map_err(io_err)
}

#[tauri::command(async)]
pub fn localdoc_trash_list(app: tauri::AppHandle) -> Result<Vec<LocalTrashItem>, CmdError> {
    trash_list_in(&docs_dir(&app)?, now_millis()).map_err(io_err)
}

#[tauri::command(async)]
pub fn localdoc_restore(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    validate_id(&id)?;
    restore_in(&docs_dir(&app)?, &id).map_err(io_err)
}

#[tauri::command(async)]
pub fn localdoc_purge(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    validate_id(&id)?;
    purge_in(&docs_dir(&app)?, &id).map_err(io_err)
}

#[tauri::command(async)]
pub fn localdoc_trash_empty(app: tauri::AppHandle) -> Result<(), CmdError> {
    empty_trash_in(&docs_dir(&app)?).map_err(io_err)
}

/// The legacy (v1) history file, as the JSON the webview wrote. Empty string
/// when there is none — the common case, and not an error.
#[tauri::command(async)]
pub fn localdoc_history_read(app: tauri::AppHandle, id: String) -> Result<String, CmdError> {
    match std::fs::read_to_string(legacy_history_path(&app, &id)?) {
        Ok(raw) => Ok(raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(io_err(e)),
    }
}

/// After migrating to v2, keep the old file as `.v1.bak` (never deleted by
/// the migration itself, in case anything went wrong).
#[tauri::command(async)]
pub fn localdoc_history_retire(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    let path = legacy_history_path(&app, &id)?;
    if path.exists() {
        rename_retrying(&path, &with_suffix(&path, ".v1.bak")).map_err(io_err)?;
    }
    Ok(())
}

/// History v2 index (JSON the webview owns); empty string when none yet.
#[tauri::command(async)]
pub fn localdoc_hist_index_read(app: tauri::AppHandle, id: String) -> Result<String, CmdError> {
    let path = history_dir(&app, &id)?.join("index.json");
    match read_with_backup(&path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map_err(|_| CmdError::new("corrupt", "history index is not text")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(io_err(e)),
    }
}

#[tauri::command(async)]
pub fn localdoc_hist_index_write(
    app: tauri::AppHandle,
    id: String,
    content: String,
) -> Result<(), CmdError> {
    if content.len() > MAX_DOC_BYTES {
        return Err(CmdError::new("too_large", "history index exceeds 16 MB"));
    }
    let path = history_dir(&app, &id)?.join("index.json");
    atomic_write(&path, content.as_bytes(), true).map_err(io_err)
}

/// One compressed version, as a raw IPC body (`x-doc` and `x-version`
/// headers) — no base64 inflation for a megabyte of history.
#[tauri::command(async)]
pub fn localdoc_hist_blob_write(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), CmdError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CmdError::new("bad_body", "expected raw version bytes"));
    };
    if bytes.len() > MAX_VERSION_BYTES {
        return Err(CmdError::new("too_large", "version exceeds 16 MB"));
    }
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .unwrap_or_default()
    };
    let (doc, version) = (header("x-doc"), header("x-version"));
    validate_id(&version)?;
    let path = history_dir(&app, &doc)?.join(format!("{version}.z"));
    atomic_write(&path, bytes, false).map_err(io_err)
}

#[tauri::command(async)]
pub fn localdoc_hist_blob_read(
    app: tauri::AppHandle,
    id: String,
    version: String,
) -> Result<tauri::ipc::Response, CmdError> {
    validate_id(&version)?;
    let path = history_dir(&app, &id)?.join(format!("{version}.z"));
    let bytes = std::fs::read(path).map_err(io_err)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command(async)]
pub fn localdoc_hist_blob_delete(
    app: tauri::AppHandle,
    id: String,
    version: String,
) -> Result<(), CmdError> {
    validate_id(&version)?;
    let path = history_dir(&app, &id)?.join(format!("{version}.z"));
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(e)),
    }
}

/// The document's feedback threads, as the JSON the webview wrote. Empty
/// string when there are none yet — the common case, not an error.
#[tauri::command(async)]
pub fn localdoc_feedback_read(app: tauri::AppHandle, id: String) -> Result<String, CmdError> {
    match read_with_backup(&feedback_path(&app, &id)?) {
        Ok(bytes) => String::from_utf8(bytes)
            .map_err(|_| CmdError::new("corrupt", "feedback file is not text")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(io_err(e)),
    }
}

#[tauri::command(async)]
pub fn localdoc_feedback_write(
    app: tauri::AppHandle,
    id: String,
    content: String,
) -> Result<(), CmdError> {
    if content.len() > MAX_DOC_BYTES {
        return Err(CmdError::new(
            "too_large",
            "local document feedback exceeds the 16 MB limit",
        ));
    }
    atomic_write(&feedback_path(&app, &id)?, content.as_bytes(), true).map_err(io_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_documents_pictures_travel_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path();
        let doc = "aaaa-1111";
        let pic = "bbbb-2222";
        std::fs::write(docs.join(format!("{doc}.json")), "{}").unwrap();
        atomic_write(&media_file(docs, doc, pic), b"png-bytes", false).unwrap();
        assert_eq!(
            media_bytes_in(docs, doc, pic).as_deref(),
            Some(&b"png-bytes"[..])
        );

        // Into Recently Deleted, and back.
        trash_in(docs, doc, 1).unwrap();
        assert!(media_bytes_in(docs, doc, pic).is_none());
        assert!(docs
            .join(TRASH_DIR)
            .join(doc)
            .join("media")
            .join(pic)
            .exists());
        restore_in(docs, doc).unwrap();
        assert_eq!(
            media_bytes_in(docs, doc, pic).as_deref(),
            Some(&b"png-bytes"[..])
        );

        // A copy gets its own, found under the address the original wrote
        // even once the original is gone for good.
        let copy = "cccc-3333";
        copy_media_in(docs, doc, copy).unwrap();
        trash_in(docs, doc, 2).unwrap();
        purge_in(docs, doc).unwrap();
        assert_eq!(
            media_bytes_in(docs, doc, pic).as_deref(),
            Some(&b"png-bytes"[..])
        );
        assert!(media_file(docs, copy, pic).exists());

        // Nothing outside the store can be named.
        assert!(media_bytes_in(docs, "../..", pic).is_none());
        assert!(media_bytes_in(docs, doc, "../../secret").is_none());
        assert!(media_bytes_in(docs, doc, "dddd-4444").is_none());
        // A document with no pictures copies nothing, without error.
        copy_media_in(docs, "eeee-5555", "ffff-6666").unwrap();
    }

    #[test]
    fn atomic_write_keeps_a_backup_and_reads_fall_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        atomic_write(&path, b"first", true).unwrap();
        atomic_write(&path, b"second", true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        assert_eq!(std::fs::read(with_suffix(&path, ".bak")).unwrap(), b"first");
        assert!(!with_suffix(&path, ".tmp").exists());
        // A crash between the renames: only the backup is left.
        std::fs::remove_file(&path).unwrap();
        assert_eq!(read_with_backup(&path).unwrap(), b"first");
    }

    #[test]
    fn recently_deleted_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        std::fs::write(
            d.join(format!("{id}.json")),
            br#"{"title":"Novel","format":"manuscript"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(d.join("meta")).unwrap();
        std::fs::write(
            d.join("meta").join(format!("{id}.json")),
            br#"{"title":"Novel","format":"manuscript","words":1200,"excerpt":"It was"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(d.join("history").join(id)).unwrap();
        std::fs::write(d.join("history").join(id).join("index.json"), b"[]").unwrap();
        std::fs::create_dir_all(d.join("feedback")).unwrap();
        std::fs::write(d.join("feedback").join(format!("{id}.json")), b"[]").unwrap();

        trash_in(d, id, 1_000).unwrap();
        assert!(!d.join(format!("{id}.json")).exists(), "gone from the list");
        assert!(
            !d.join("history").join(id).exists(),
            "history moved with it"
        );
        let listed = trash_list_in(d, 2_000).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "Novel");
        assert_eq!(listed[0].words, 1200);
        assert_eq!(listed[0].deleted_at, 1_000);

        restore_in(d, id).unwrap();
        assert!(d.join(format!("{id}.json")).exists());
        assert!(d.join("history").join(id).join("index.json").exists());
        assert!(d.join("feedback").join(format!("{id}.json")).exists());
        assert!(d.join("meta").join(format!("{id}.json")).exists());
        assert!(trash_list_in(d, 2_000).unwrap().is_empty());

        // Purge, empty, and expiry after 30 days.
        trash_in(d, id, 1_000).unwrap();
        purge_in(d, id).unwrap();
        assert!(trash_list_in(d, 2_000).unwrap().is_empty());
        assert!(restore_in(d, id).is_err());
        for n in 0..2 {
            let other = format!("0f8fad5b-d9cb-469f-a165-7086772895{n}0");
            std::fs::write(d.join(format!("{other}.json")), br#"{"title":"X"}"#).unwrap();
            trash_in(d, &other, 1_000).unwrap();
        }
        assert_eq!(trash_list_in(d, 2_000).unwrap().len(), 2);
        assert!(
            trash_list_in(d, 1_000 + TRASH_RETENTION_MS + 1)
                .unwrap()
                .is_empty(),
            "expired ones go"
        );
        std::fs::write(d.join(format!("{id}.json")), br#"{"title":"Y"}"#).unwrap();
        trash_in(d, id, 1_000).unwrap();
        empty_trash_in(d).unwrap();
        assert!(trash_list_in(d, 2_000).unwrap().is_empty());
    }

    #[test]
    fn search_reads_each_documents_text() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let (a, b, c) = ("aaaa-0001", "bbbb-0002", "cccc-0003");
        for id in [a, b, c] {
            std::fs::write(d.join(format!("{id}.json")), "{}").unwrap();
        }
        // The folders file and stray files are never taken for documents.
        std::fs::write(d.join(FOLDERS_FILE), "{}").unwrap();
        write_text_in(d, a, "The lighthouse keeper counted the ships.\nNone came.").unwrap();
        write_text_in(d, b, "A recipe for bread").unwrap();

        let found = search_in(d, "  LIGHTHOUSE ").unwrap();
        assert_eq!(found.hits.len(), 1);
        assert_eq!(found.hits[0].id, a);
        assert!(found.hits[0].snippet.contains("lighthouse keeper"));
        assert!(!found.hits[0].snippet.contains('\n'), "one line");
        // The document with no text yet is the one to bring up to date.
        assert_eq!(found.stale, vec![c.to_string()]);
        assert!(search_in(d, "").unwrap().hits.is_empty());
        assert!(search_in(d, "zeppelin").unwrap().hits.is_empty());

        // Its text goes to Recently Deleted with it, and comes back.
        trash_in(d, a, 1).unwrap();
        assert!(search_in(d, "lighthouse").unwrap().hits.is_empty());
        restore_in(d, a).unwrap();
        assert_eq!(search_in(d, "lighthouse").unwrap().hits.len(), 1);

        // Text older than its document is stale (and still searched).
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(text_file(d, b))
            .unwrap()
            .set_modified(old)
            .unwrap();
        let found = search_in(d, "bread").unwrap();
        assert_eq!(found.hits.len(), 1);
        assert!(found.stale.contains(&b.to_string()));
    }

    #[test]
    fn ids_cannot_traverse() {
        assert!(validate_id("../etc").is_err());
        assert!(validate_id("").is_err());
        assert!(validate_id("0f8fad5b-d9cb-469f-a165-70867728950e").is_ok());
    }
}
