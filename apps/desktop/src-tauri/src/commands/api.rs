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

pub(crate) fn active_client(
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

/// Largest export the app will write (a picture-heavy board or a long book).
const MAX_SAVE_BYTES: usize = 256 * 1024 * 1024;

/// What the app exports: the Save panel's filter label and the extension the
/// written file is forced to carry.
fn export_kind(kind: &str) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        "pdf" => ("PDF document", "pdf"),
        "epub" => ("EPUB ebook", "epub"),
        "docx" => ("Word document", "docx"),
        "zip" => ("Zip archive", "zip"),
        "wfboard" => ("subScribe board", "wfboard"),
        _ => return None,
    })
}

/// Header values are ASCII, so the webview percent-encodes the file name.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A file name safe on every platform, ending in `.{ext}`.
fn export_file_name(raw: &str, ext: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let mut stem = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let dotted = format!(".{ext}");
    if stem.to_lowercase().ends_with(&dotted) {
        stem.truncate(stem.len() - dotted.len());
    }
    let stem = stem.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let stem: String = if stem.is_empty() {
        "Untitled".to_string()
    } else {
        stem.chars().take(150).collect()
    };
    format!("{stem}.{ext}")
}

/// `name` in `dir`, or `name (2)`, `name (3)`… if that file already exists —
/// an export never silently replaces an earlier one.
#[cfg_attr(desktop, allow(dead_code))]
fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = std::path::Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (2..10_000)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(candidate)
}

#[derive(Debug, Clone, Serialize)]
pub struct SavedFile {
    /// Absolute path of the written file.
    pub path: String,
    /// Where it went, in words the user recognizes.
    pub location: String,
    /// Whether the desktop file manager can reveal it.
    pub revealable: bool,
}

/// Save an export the user asked for. The bytes arrive as a raw IPC body
/// (`x-file-name`, percent-encoded, and `x-file-kind` headers). On desktop
/// the native Save panel picks the destination and this command writes the
/// file itself — the webview never supplies a path. On iOS there is no
/// writable save panel, so the file lands in the app's Documents folder,
/// which Info.ios.plist exposes in the Files app. `None` = the user cancelled.
#[tauri::command]
pub async fn save_file(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<SavedFile>, CmdError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CmdError::new("bad_body", "expected the file's raw bytes"));
    };
    if bytes.len() > MAX_SAVE_BYTES {
        return Err(CmdError::new(
            "too_large",
            "export exceeds the 256 MB limit",
        ));
    }
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let kind = header("x-file-kind").unwrap_or_default();
    let (filter, ext) =
        export_kind(&kind).ok_or_else(|| CmdError::new("bad_kind", "unknown export kind"))?;
    let name = export_file_name(
        &percent_decode(&header("x-file-name").unwrap_or_default()),
        ext,
    );

    #[cfg(desktop)]
    {
        use tauri::Manager;
        use tauri_plugin_dialog::DialogExt;

        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Export")
            .set_file_name(&name)
            .add_filter(filter, &[ext]);
        if let Ok(dir) = app.path().download_dir() {
            dialog = dialog.set_directory(dir);
        }
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        dialog.save_file(move |picked| {
            let _ = tx.send(picked);
        });
        let Some(picked) = rx.await.ok().flatten() else {
            return Ok(None);
        };
        let mut path = picked
            .into_path()
            .map_err(|e| CmdError::new("bad_path", e.to_string()))?;
        // A name retyped in the panel can lose the extension; the file's
        // kind is fixed by what was exported, so put it back.
        let has_ext = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case(ext));
        if !has_ext {
            let file = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| name.clone());
            path.set_file_name(format!("{file}.{ext}"));
        }
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|e| CmdError::new("write_failed", format!("could not save the file: {e}")))?;
        let location = path
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(Some(SavedFile {
            path: path.display().to_string(),
            location,
            revealable: true,
        }))
    }

    #[cfg(mobile)]
    {
        use tauri::Manager;
        let _ = filter;
        let dir = app
            .path()
            .document_dir()
            .map_err(|e| CmdError::new("no_dir", format!("no Documents folder: {e}")))?;
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| CmdError::new("io", e.to_string()))?;
        let path = unique_path(&dir, &name);
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|e| CmdError::new("write_failed", format!("could not save the file: {e}")))?;
        Ok(Some(SavedFile {
            path: path.display().to_string(),
            location: "Files › On My iPhone › subScribe".to_string(),
            revealable: false,
        }))
    }
}

#[cfg(test)]
mod save_tests {
    use super::*;

    #[test]
    fn file_names_are_safe_and_keep_their_extension() {
        assert_eq!(
            export_file_name("My: Book/Draft?", "pdf"),
            "My Book Draft.pdf"
        );
        assert_eq!(export_file_name("Novel.pdf", "pdf"), "Novel.pdf");
        assert_eq!(export_file_name("  ...  ", "epub"), "Untitled.epub");
        assert_eq!(export_file_name("a\u{0}b", "docx"), "a b.docx");
    }

    #[test]
    fn percent_decoding_round_trips_utf8() {
        assert_eq!(
            percent_decode("Caf%C3%A9%20%E2%80%94%20Draft"),
            "Café — Draft"
        );
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn unique_path_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let first = unique_path(dir.path(), "Book.pdf");
        assert_eq!(first.file_name().unwrap(), "Book.pdf");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_path(dir.path(), "Book.pdf");
        assert_eq!(second.file_name().unwrap(), "Book (2).pdf");
    }
}

/// Largest file the importer will pull into the webview. Imports are parsed
/// in JS (mammoth/pdfjs), so this bounds memory in the renderer, not on disk.
const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;

/// Read a file the user dragged onto the app so the importer can parse it.
///
/// Native drag & drop hands us a path, not a `File` — and unlike chat
/// uploads (which stream straight to the server) document import has to
/// examine the bytes locally, so they have to come back to the webview.
#[tauri::command]
pub async fn read_dropped_file(path: String) -> Result<serde_json::Value, CmdError> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| CmdError::new("no_such_file", format!("cannot read {path}: {e}")))?;
    if meta.is_dir() {
        return Err(CmdError::new(
            "is_directory",
            "that's a folder — drop a single document file instead",
        ));
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(CmdError::new(
            "too_large",
            "that file is larger than 64 MB — import it in smaller pieces",
        ));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| CmdError::new("read_failed", format!("could not read the file: {e}")))?;
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".to_string());
    Ok(serde_json::json!({ "name": name, "data_base64": B64.encode(&bytes) }))
}
