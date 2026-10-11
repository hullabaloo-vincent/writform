//! Catalog fonts on this device.
//!
//! A document can use any family from the open font catalog; its files are
//! fetched the first time they're needed and kept in the app's cache. Where
//! a file comes from, in order:
//!
//! 1. this device's cache;
//! 2. the server you're connected to, which keeps its own copies (so a
//!    group downloads each font once, over the pinned connection);
//! 3. the catalog's public CDN — the one request this app makes to a third
//!    party, and only when the online library is switched on.
//!
//! File names follow a strict grammar (`{family id}/{subset}-{weight}-
//! {style}.ttf`), so nothing here fetches an address the webview made up.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;
use writform_server::routes::fonts::{
    looks_like_font, valid_font_file, valid_font_id, DEFAULT_UPSTREAM, MAX_FONT_BYTES,
};

use crate::commands::connect::CmdError;
use crate::servers::ConnectionManager;

/// Everything kept on this device. Past this, the files unused longest go.
pub const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, CmdError> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| CmdError::new("no_cache_dir", e.to_string()))?
        .join("fonts"))
}

fn io_err(e: std::io::Error) -> CmdError {
    CmdError::new("io", e.to_string())
}

/// Every cached file: (last used, size, path).
fn cached_files(dir: &Path) -> Vec<(std::time::SystemTime, u64, PathBuf)> {
    let mut out = Vec::new();
    let Ok(families) = std::fs::read_dir(dir) else {
        return out;
    };
    for family in families.flatten() {
        let Ok(entries) = std::fs::read_dir(family.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    let at = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                    out.push((at, meta.len(), entry.path()));
                }
            }
        }
    }
    out
}

/// Keep the cache under `limit`: drop the files used longest ago.
pub fn trim_cache(dir: &Path, limit: u64) {
    let mut files = cached_files(dir);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= limit {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= limit {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

/// Read a cached file and mark it used now (so it's the last to be dropped).
pub fn read_cached(dir: &Path, id: &str, file: &str) -> Option<Vec<u8>> {
    let path = dir.join(id).join(file);
    let bytes = std::fs::read(&path).ok()?;
    if !looks_like_font(&bytes) {
        // Truncated or foreign: not worth keeping.
        let _ = std::fs::remove_file(&path);
        return None;
    }
    if let Ok(f) = std::fs::File::options().write(true).open(&path) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
    Some(bytes)
}

pub fn write_cached(dir: &Path, id: &str, file: &str, bytes: &[u8]) -> std::io::Result<()> {
    crate::localdocs::atomic_write(&dir.join(id).join(file), bytes, false)?;
    trim_cache(dir, MAX_CACHE_BYTES);
    Ok(())
}

/// One place a font can be fetched from.
pub struct Source {
    pub client: reqwest::Client,
    /// The file's full address.
    pub url: String,
    pub bearer: Option<String>,
}

/// Fetch from the first source that has it. `Ok(None)`: none did.
pub async fn fetch_from(sources: Vec<Source>) -> Option<Vec<u8>> {
    for source in sources {
        let mut req = source.client.get(&source.url).timeout(FETCH_TIMEOUT);
        if let Some(token) = &source.bearer {
            req = req.bearer_auth(token);
        }
        let Ok(res) = req.send().await else {
            continue;
        };
        if !res.status().is_success()
            || res
                .content_length()
                .is_some_and(|n| n > MAX_FONT_BYTES as u64)
        {
            continue;
        }
        let Ok(bytes) = res.bytes().await else {
            continue;
        };
        if bytes.len() <= MAX_FONT_BYTES && looks_like_font(&bytes) {
            return Some(bytes.to_vec());
        }
    }
    None
}

/// A catalog font file's bytes: from the cache, else fetched and cached.
/// `online` allows the public CDN (the user's "online font library" switch).
#[tauri::command]
pub async fn font_fetch(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ConnectionManager>,
    id: String,
    file: String,
    online: bool,
) -> Result<tauri::ipc::Response, CmdError> {
    if !valid_font_id(&id) || !valid_font_file(&file) {
        return Err(CmdError::new("bad_font", "not a catalog font file"));
    }
    let dir = cache_dir(&app)?;
    let (cache, cid, cfile) = (dir.clone(), id.clone(), file.clone());
    let hit = tauri::async_runtime::spawn_blocking(move || read_cached(&cache, &cid, &cfile))
        .await
        .ok()
        .flatten();
    if let Some(bytes) = hit {
        return Ok(tauri::ipc::Response::new(bytes));
    }

    let mut sources = Vec::new();
    {
        let active = manager.active.lock().expect("poisoned");
        if let Some(s) = active.as_ref() {
            sources.push(Source {
                client: s.client.clone(),
                url: format!("https://{}/api/v1/fonts/{id}/{file}", s.addr),
                bearer: Some(s.token.clone()),
            });
        }
    }
    if online {
        if let Ok(client) = reqwest::Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::limited(3))
            .user_agent("subScribe/1.0")
            .build()
        {
            sources.push(Source {
                client,
                url: format!("{DEFAULT_UPSTREAM}/{id}@latest/{file}"),
                bearer: None,
            });
        }
    }
    let Some(bytes) = fetch_from(sources).await else {
        return Err(CmdError::new(
            "font_unavailable",
            if online {
                "that font couldn't be downloaded"
            } else {
                "that font isn't on this device, and the online font library is off"
            },
        ));
    };
    let stored = bytes.clone();
    let _ =
        tauri::async_runtime::spawn_blocking(move || write_cached(&dir, &id, &file, &stored)).await;
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Debug, Clone, Serialize)]
pub struct FontCacheInfo {
    pub bytes: u64,
    pub files: u32,
    pub limit: u64,
}

#[tauri::command(async)]
pub fn font_cache_info(app: tauri::AppHandle) -> Result<FontCacheInfo, CmdError> {
    let files = cached_files(&cache_dir(&app)?);
    Ok(FontCacheInfo {
        bytes: files.iter().map(|f| f.1).sum(),
        files: files.len() as u32,
        limit: MAX_CACHE_BYTES,
    })
}

/// Forget every downloaded font (they download again when next needed).
#[tauri::command(async)]
pub fn font_cache_clear(app: tauri::AppHandle) -> Result<(), CmdError> {
    match std::fs::remove_dir_all(cache_dir(&app)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io_err(e)),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FONT: &[u8] = &[
        0x00, 0x01, 0x00, 0x00, 0, 12, 0, 0x80, 0, 3, 0, 0x40, 9, 9, 9, 9,
    ];

    #[test]
    fn the_cache_keeps_fonts_and_forgets_the_least_used() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path();
        assert!(read_cached(cache, "inter", "latin-400-normal.ttf").is_none());
        write_cached(cache, "inter", "latin-400-normal.ttf", FONT).unwrap();
        write_cached(cache, "lora", "latin-400-normal.ttf", FONT).unwrap();
        assert_eq!(
            read_cached(cache, "inter", "latin-400-normal.ttf").as_deref(),
            Some(FONT)
        );

        // Make "lora" the stale one, then squeeze: it goes, "inter" stays.
        let old = std::time::SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(cache.join("lora/latin-400-normal.ttf"))
            .unwrap()
            .set_modified(old)
            .unwrap();
        trim_cache(cache, FONT.len() as u64);
        assert!(cache.join("inter/latin-400-normal.ttf").exists());
        assert!(!cache.join("lora/latin-400-normal.ttf").exists());

        // A file that isn't a font is dropped rather than handed out.
        std::fs::write(cache.join("inter/latin-700-normal.ttf"), b"<html>").unwrap();
        assert!(read_cached(cache, "inter", "latin-700-normal.ttf").is_none());
        assert!(!cache.join("inter/latin-700-normal.ttf").exists());
    }
}
