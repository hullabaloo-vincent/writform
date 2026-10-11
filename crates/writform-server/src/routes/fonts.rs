//! Catalog fonts, fetched once and kept.
//!
//! Documents can use any family of the open font catalog (Fontsource's
//! mirror of the Google Fonts library). A client that needs one asks its
//! own server for the file; the server fetches it from the public CDN the
//! first time and serves its own copy from then on. So a browser client
//! never talks to a third party, a whole group downloads each font once,
//! and a font keeps working if the CDN goes away.
//!
//! Guardrails: authenticated; the path is built from a strict grammar (a
//! family id and a `subset-weight-style.ttf` file name), never from a URL
//! the client supplies, so this is not an open proxy; the body must be a
//! font; sizes are capped; the cache is bounded. `WRITFORM_FONT_PROXY=off`
//! stops fetching (already cached files are still served).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::extract::{Path as UrlPath, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::auth::AuthUser;
use crate::error::AppError;
use crate::routes::AppState;

/// Where catalog files come from: `{upstream}/{id}@latest/{file}`.
pub const DEFAULT_UPSTREAM: &str = "https://cdn.jsdelivr.net/fontsource/fonts";
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// One file. Latin subsets are tens of kilobytes; a full CJK face, megabytes.
pub const MAX_FONT_BYTES: usize = 32 * 1024 * 1024;
/// Everything kept. Past this, the files unused longest go first.
const MAX_CACHE_BYTES: u64 = 1024 * 1024 * 1024;

pub struct FontCache {
    pub dir: PathBuf,
    /// Base address of the catalog's files (a field so tests can point it
    /// at a local server).
    pub upstream: String,
    /// Fetch files this server doesn't have yet.
    pub enabled: AtomicBool,
}

impl FontCache {
    pub fn new(data_dir: &Path) -> Self {
        let off = std::env::var("WRITFORM_FONT_PROXY")
            .map(|v| {
                matches!(
                    v.to_ascii_lowercase().as_str(),
                    "off" | "0" | "false" | "no"
                )
            })
            .unwrap_or(false);
        Self {
            dir: data_dir.join("fonts"),
            upstream: DEFAULT_UPSTREAM.to_string(),
            enabled: AtomicBool::new(!off),
        }
    }
}

/// A catalog family id: lowercase letters, digits and dashes.
pub fn valid_font_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A catalog file name: `{subset}-{weight}-{normal|italic}.ttf`.
pub fn valid_font_file(file: &str) -> bool {
    let Some(stem) = file.strip_suffix(".ttf") else {
        return false;
    };
    let mut parts = stem.rsplitn(3, '-');
    let (Some(style), Some(weight), Some(subset)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    matches!(style, "normal" | "italic")
        && matches!(
            weight,
            "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900"
        )
        && !subset.is_empty()
        && subset.len() <= 40
        && subset
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// TrueType, OpenType/CFF, or a collection — by its first four bytes.
pub fn looks_like_font(bytes: &[u8]) -> bool {
    bytes.len() > 12
        && matches!(
            &bytes[..4],
            [0x00, 0x01, 0x00, 0x00] | b"OTTO" | b"true" | b"ttcf"
        )
}

fn font_response(bytes: Vec<u8>) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "font/ttf"),
            // A file's name pins its content for as long as anyone cares.
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable",
            ),
        ],
        bytes,
    )
        .into_response()
}

/// Keep the cache under its ceiling: drop the files modified longest ago.
fn trim_cache(dir: &Path) {
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let Ok(families) = std::fs::read_dir(dir) else {
        return;
    };
    for family in families.flatten() {
        let Ok(entries) = std::fs::read_dir(family.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    let at = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                    files.push((at, meta.len(), entry.path()));
                }
            }
        }
    }
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= MAX_CACHE_BYTES {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= MAX_CACHE_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

pub async fn font_file(
    State(state): State<AppState>,
    _auth: AuthUser,
    UrlPath((id, file)): UrlPath<(String, String)>,
) -> Result<Response, AppError> {
    if !valid_font_id(&id) || !valid_font_file(&file) {
        return Err(AppError::bad_request("bad_font", "not a catalog font file"));
    }
    let cache = state.fonts.clone();
    let path = cache.dir.join(&id).join(&file);
    if let Ok(bytes) = tokio::fs::read(&path).await {
        return Ok(font_response(bytes));
    }
    if !cache.enabled.load(Ordering::Relaxed) {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "font_proxy_off",
            "this server doesn't fetch fonts",
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent("subScribe-FontCache/1.0")
        .build()
        .map_err(AppError::internal)?;
    let url = format!("{}/{id}@latest/{file}", cache.upstream);
    let unavailable = |why: &str| {
        AppError::new(
            StatusCode::BAD_GATEWAY,
            "font_unavailable",
            format!("the font couldn't be fetched ({why})"),
        )
    };
    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|_| unavailable("the catalog didn't answer"))?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_font",
            "the catalog has no such font file",
        ));
    }
    if !res.status().is_success() {
        return Err(unavailable("the catalog refused"));
    }
    if res
        .content_length()
        .is_some_and(|n| n > MAX_FONT_BYTES as u64)
    {
        return Err(unavailable("the file is too large"));
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|_| unavailable("the download was cut short"))?;
    if bytes.len() > MAX_FONT_BYTES {
        return Err(unavailable("the file is too large"));
    }
    if !looks_like_font(&bytes) {
        return Err(unavailable("what came back isn't a font"));
    }

    // Temp file, then rename: a reader never sees half a font.
    let dir = cache.dir.join(&id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(AppError::internal)?;
    let tmp = dir.join(format!(".{file}.{}.tmp", std::process::id()));
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(AppError::internal)?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(AppError::internal)?;
    let root = cache.dir.clone();
    tokio::task::spawn_blocking(move || trim_cache(&root));

    Ok(font_response(bytes.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_catalog_names_pass() {
        assert!(valid_font_id("inter"));
        assert!(valid_font_id("eb-garamond"));
        assert!(valid_font_id("m-plus-1p"));
        for bad in ["", "Inter", "../x", "a/b", "a.b", "-x", "a b", "a%2fb"] {
            assert!(!valid_font_id(bad), "{bad}");
        }
        assert!(valid_font_file("latin-400-normal.ttf"));
        assert!(valid_font_file("latin-ext-700-italic.ttf"));
        assert!(valid_font_file("chinese-simplified-400-normal.ttf"));
        for bad in [
            "latin-400-normal.woff2",
            "latin-450-normal.ttf",
            "latin-400-oblique.ttf",
            "-400-normal.ttf",
            "../latin-400-normal.ttf",
            "latin/400-normal.ttf",
            "Latin-400-normal.ttf",
            "400-normal.ttf",
            "latin-400-normal.ttf/..",
        ] {
            assert!(!valid_font_file(bad), "{bad}");
        }
    }

    #[test]
    fn fonts_are_known_by_their_first_bytes() {
        assert!(looks_like_font(&[0, 1, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0]));
        assert!(looks_like_font(b"OTTO\0\x0c\0\0\0\0\0\0\0"));
        assert!(!looks_like_font(b"<!doctype html><html>"));
        assert!(!looks_like_font(b"OTTO"));
        assert!(!looks_like_font(b""));
    }
}
