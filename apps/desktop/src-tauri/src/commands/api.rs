//! Generic authenticated API proxy. The frontend (and later, plugins through
//! the permission broker) reaches the connected server exclusively through
//! this command — requests ride the pinned TLS client with the bearer token,
//! and only `/api/v1/` paths on the active server are reachable.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use tauri::State;

use crate::commands::connect::CmdError;
use crate::servers::ConnectionManager;

#[derive(Debug, Clone, Serialize)]
pub struct ApiResponse {
    pub status: u16,
    /// Response body parsed as JSON (null for empty bodies).
    pub body: serde_json::Value,
}

fn active_client(
    manager: &ConnectionManager,
) -> Result<(reqwest::Client, String, String), CmdError> {
    let active = manager.active.lock().expect("poisoned");
    let session = active.as_ref().ok_or_else(|| CmdError {
        code: "not_connected".into(),
        message: "not connected to a server".into(),
    })?;
    Ok((
        session.client.clone(),
        session.addr.clone(),
        session.token.clone(),
    ))
}

fn validate_path(path: &str) -> Result<(), CmdError> {
    if !path.starts_with("/api/v1/") || path.contains("..") {
        return Err(CmdError {
            code: "bad_path".into(),
            message: "only /api/v1/ paths are allowed".into(),
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn api_fetch(
    manager: State<'_, ConnectionManager>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<ApiResponse, CmdError> {
    validate_path(&path)?;
    let (client, addr, token) = active_client(&manager)?;

    let method: reqwest::Method = method.to_uppercase().parse().map_err(|_| CmdError {
        code: "bad_method".into(),
        message: "invalid HTTP method".into(),
    })?;
    let mut req = client
        .request(method, format!("https://{addr}{path}"))
        .bearer_auth(token);
    if let Some(body) = body {
        req = req.json(&body);
    }
    let res = req.send().await.map_err(|e| CmdError {
        code: "unreachable".into(),
        message: format!("request failed: {e}"),
    })?;

    let status = res.status().as_u16();
    let bytes = res.bytes().await.map_err(|e| CmdError {
        code: "bad_response".into(),
        message: e.to_string(),
    })?;
    let body = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    Ok(ApiResponse { status, body })
}

/// Upload an attachment from raw bytes (base64 from the webview — pasted
/// images) or a file path (drag & drop).
#[tauri::command]
pub async fn upload_attachment(
    manager: State<'_, ConnectionManager>,
    data_base64: Option<String>,
    file_path: Option<String>,
    file_name: Option<String>,
) -> Result<ApiResponse, CmdError> {
    let (client, addr, token) = active_client(&manager)?;

    let (bytes, name) = match (data_base64, file_path) {
        (Some(b64), _) => (
            B64.decode(b64.as_bytes()).map_err(|_| CmdError {
                code: "bad_data".into(),
                message: "invalid base64 payload".into(),
            })?,
            file_name.unwrap_or_else(|| "pasted".into()),
        ),
        (None, Some(path)) => {
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".into());
            (
                tokio::fs::read(&path).await.map_err(|e| CmdError {
                    code: "read_failed".into(),
                    message: e.to_string(),
                })?,
                name,
            )
        }
        (None, None) => {
            return Err(CmdError {
                code: "no_data".into(),
                message: "provide data_base64 or file_path".into(),
            })
        }
    };

    let part = reqwest::multipart::Part::bytes(bytes).file_name(name);
    let form = reqwest::multipart::Form::new().part("file", part);
    let res = client
        .post(format!("https://{addr}/api/v1/attachments"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| CmdError {
            code: "unreachable".into(),
            message: format!("upload failed: {e}"),
        })?;
    let status = res.status().as_u16();
    let body: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
    Ok(ApiResponse { status, body })
}

/// Write an export archive to the user's Downloads folder (Documents, then
/// home as fallbacks). No dialog: the caller shows the returned path.
#[tauri::command]
pub async fn save_export(
    app: tauri::AppHandle,
    file_name: String,
    data_base64: String,
) -> Result<String, CmdError> {
    use tauri::Manager;
    let bytes = B64
        .decode(&data_base64)
        .map_err(|_| CmdError::new("bad_data", "export payload is not valid base64"))?;
    let safe: String = file_name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '\0'))
        .collect();
    let name = if safe.trim().is_empty() {
        "writform-export.zip".to_string()
    } else {
        safe
    };
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .or_else(|_| app.path().home_dir())
        .map_err(|e| CmdError::new("no_dir", format!("no writable folder found: {e}")))?;
    let path = dir.join(name);
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| CmdError::new("write_failed", format!("could not write export: {e}")))?;
    Ok(path.display().to_string())
}
