//! Server-side link previews for canvas link cards.
//!
//! The server (which has outbound network access, unlike the pinned desktop
//! client) fetches the page and extracts `<title>` / OpenGraph metadata.
//! Guardrails: http/https only, short timeout, response size cap, HTML only,
//! and an in-memory cache. Endpoint is authenticated; this is a self-hosted
//! friend-server, not an open proxy — posture documented in docs/protocol.md.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use writform_proto::api::LinkPreview;

use crate::auth::AuthUser;
use crate::error::AppError;
use crate::routes::AppState;

const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BODY_BYTES: usize = 512 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const CACHE_CAP: usize = 256;

#[derive(Default)]
pub struct PreviewCache {
    entries: Mutex<HashMap<String, (Instant, LinkPreview)>>,
}

#[derive(Deserialize)]
pub struct PreviewQuery {
    pub url: String,
}

/// Pull the content of the first capture of `re`-like pattern: we avoid a
/// regex dependency with a small scan for `<title>` and og meta tags.
fn find_tag_content(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let open = lower.find(&format!("<{tag}"))?;
    let start = lower[open..].find('>')? + open + 1;
    let end = lower[start..].find(&format!("</{tag}"))? + start;
    let raw = html.get(start..end)?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(decode_entities(raw))
    }
}

/// Value of `<meta property="og:xxx" content="...">` (attribute order agnostic).
fn find_og(html: &str, property: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let needle = format!("property=\"og:{property}\"");
    let alt = format!("name=\"og:{property}\"");
    let pos = lower.find(&needle).or_else(|| lower.find(&alt))?;
    // Scan the enclosing tag for content="...".
    let tag_start = lower[..pos].rfind('<')?;
    let tag_end = lower[pos..].find('>')? + pos;
    let tag = &html[tag_start..tag_end];
    let cpos = tag.to_lowercase().find("content=\"")? + "content=\"".len();
    let cend = tag[cpos..].find('"')? + cpos;
    let raw = tag.get(cpos..cend)?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(decode_entities(raw))
    }
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

pub async fn link_preview(
    State(state): State<AppState>,
    _auth: AuthUser,
    Query(query): Query<PreviewQuery>,
) -> Result<Json<LinkPreview>, AppError> {
    let url = query.url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::bad_request(
            "bad_url",
            "only http(s) links can be previewed",
        ));
    }

    if let Some((at, cached)) = state
        .previews
        .entries
        .lock()
        .expect("poisoned")
        .get(&url)
        .cloned()
    {
        if at.elapsed() < CACHE_TTL {
            return Ok(Json(cached));
        }
    }

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(4))
        .user_agent("WritForm-LinkPreview/1.0")
        .build()
        .map_err(AppError::internal)?;

    let preview = match fetch_preview(&client, &url).await {
        Ok(p) => p,
        // Unreachable/opaque pages still get a card — just without metadata.
        Err(_) => LinkPreview {
            url: url.clone(),
            title: None,
            description: None,
            image_url: None,
        },
    };

    let mut cache = state.previews.entries.lock().expect("poisoned");
    if cache.len() >= CACHE_CAP {
        // Evict the oldest entry (small map; a scan is fine).
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, (at, _))| *at)
            .map(|(k, _)| k.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(url, (Instant::now(), preview.clone()));
    Ok(Json(preview))
}

async fn fetch_preview(client: &reqwest::Client, url: &str) -> anyhow::Result<LinkPreview> {
    let res = client.get(url).send().await?;
    let is_html = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/html"))
        .unwrap_or(false);
    if !is_html {
        anyhow::bail!("not html");
    }

    // Stream with a hard size cap: metadata lives in <head>.
    let mut body: Vec<u8> = Vec::new();
    let mut stream = res;
    while let Some(chunk) = stream.chunk().await? {
        body.extend_from_slice(&chunk);
        if body.len() >= MAX_BODY_BYTES {
            break;
        }
    }
    let html = String::from_utf8_lossy(&body);

    Ok(LinkPreview {
        url: url.to_string(),
        title: find_og(&html, "title").or_else(|| find_tag_content(&html, "title")),
        description: find_og(&html, "description"),
        image_url: find_og(&html, "image"),
    })
}
