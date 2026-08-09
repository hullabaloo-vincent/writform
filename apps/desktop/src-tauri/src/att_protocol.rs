//! `writform-att://` custom URI scheme: lets the webview render attachment
//! images while every byte still travels over the pinned TLS client.
//!
//! URL shape: `writform-att://attachment/<id>` (the webview can't pin certs,
//! so it never fetches from the server directly). Windows is the exception:
//! WebView2 refuses bare custom schemes, so Tauri serves this same handler
//! from `http(s)://writform-att.localhost/attachment/<id>` there — the kind
//! moves from the URI's host into its first path segment.

use tauri::http::{header, Response, StatusCode};
use tauri::Manager;

use crate::servers::ConnectionManager;

/// Content type from the file's own magic bytes — local media is stored as
/// the raw bytes that were pasted, with no sidecar metadata.
fn sniff_image(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(b"<svg") || bytes.starts_with(b"<?xml") {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    }
}

pub fn handle(
    ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let uri = request.uri().clone();
    tauri::async_runtime::spawn(async move {
        let respond_err = |responder: tauri::UriSchemeResponder, status: StatusCode| {
            responder.respond(
                Response::builder()
                    .status(status)
                    .body(Vec::new())
                    .expect("valid response"),
            );
        };

        // Normalise the two platform shapes to (kind, rest): macOS/Linux
        // carry the kind as the host (`writform-att://attachment/1`), Windows
        // as the first path segment (`http://writform-att.localhost/attachment/1`).
        let host = uri.host().unwrap_or_default();
        let path = uri.path().trim_start_matches('/');
        let (kind, rest) = if host.ends_with(".localhost") || host == "localhost" {
            path.split_once('/').unwrap_or((path, ""))
        } else {
            (host, path)
        };

        // `localboard/<media>`: a picture this device owns, read straight off
        // disk. No server, no account — offline boards keep their images.
        if kind == "localboard" {
            let Some(bytes) = crate::localboards::media_bytes(&app, rest) else {
                return respond_err(responder, StatusCode::NOT_FOUND);
            };
            return responder.respond(
                Response::builder()
                    .status(StatusCode::OK)
                    // <img> loads skip CORS; fetch() (board export) does not.
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::CONTENT_TYPE, sniff_image(&bytes))
                    // Media ids are unique per picture, so this never goes stale.
                    .header(
                        header::CACHE_CONTROL,
                        "private, max-age=31536000, immutable",
                    )
                    .body(bytes)
                    .expect("valid response"),
            );
        }

        // `attachment/<id>`: fetched from the server over the pinned client.
        let id = rest;
        if kind != "attachment" || id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
            return respond_err(responder, StatusCode::BAD_REQUEST);
        }

        let manager = app.state::<ConnectionManager>();
        let (client, addr, token) = {
            let active = manager.active.lock().expect("poisoned");
            match active.as_ref() {
                Some(s) => (s.client.clone(), s.addr.clone(), s.token.clone()),
                None => return respond_err(responder, StatusCode::UNAUTHORIZED),
            }
        };

        match client
            .get(format!("https://{addr}/api/v1/attachments/{id}"))
            .bearer_auth(token)
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => {
                let mime = res
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("application/octet-stream")
                    .to_string();
                match res.bytes().await {
                    Ok(bytes) => responder.respond(
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .header(header::CONTENT_TYPE, mime)
                            .header(
                                header::CACHE_CONTROL,
                                "private, max-age=31536000, immutable",
                            )
                            .body(bytes.to_vec())
                            .expect("valid response"),
                    ),
                    Err(_) => respond_err(responder, StatusCode::BAD_GATEWAY),
                }
            }
            Ok(res) => respond_err(
                responder,
                StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            ),
            Err(_) => respond_err(responder, StatusCode::BAD_GATEWAY),
        }
    });
}
