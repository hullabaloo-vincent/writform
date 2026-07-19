//! `writform-att://` custom URI scheme: lets the webview render attachment
//! images while every byte still travels over the pinned TLS client.
//!
//! URL shape: `writform-att://attachment/<id>` (the webview can't pin certs,
//! so it never fetches from the server directly).

use tauri::http::{header, Response, StatusCode};
use tauri::Manager;

use crate::servers::ConnectionManager;

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

        // Path is /<id>; host is "attachment".
        let id = uri.path().trim_start_matches('/');
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
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
