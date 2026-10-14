//! PDFs kept on this device.
//!
//! A PDF opened to be edited is somebody's file: the app changes a copy in
//! memory and saves where it is told. One that is kept here is a file of
//! the app's own, so it can be come back to: `{app_data_dir}/local-pdfs/`
//! holds each as `{id}.pdf`, and `index.json` says what each is called.
//!
//! Taking one off the shelf marks it in the index and leaves its file for
//! thirty days, so it can be put back.

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::commands::api::percent_decode;
use crate::commands::connect::CmdError;
use crate::localdocs::atomic_write;

/// Largest PDF kept (a little over the most the editor opens).
const MAX_PDF_BYTES: usize = 96 * 1024 * 1024;
/// How long one taken off the shelf can still be put back.
const KEEP_DELETED_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalPdfMeta {
    pub id: String,
    pub name: String,
    pub bytes: u64,
    /// Milliseconds since 1970.
    pub modified_at: i64,
    /// When it was taken off the shelf (absent: it is on it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
}

fn io_err(e: std::io::Error) -> CmdError {
    CmdError::new("io", e.to_string())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn pdfs_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CmdError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::new("no_data_dir", e.to_string()))?
        .join("local-pdfs");
    std::fs::create_dir_all(&dir).map_err(io_err)?;
    Ok(dir)
}

/// Ids are made by the app (UUIDs): hex and dashes only, so they are safe
/// as file names and cannot climb out of the folder.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn file_of(dir: &std::path::Path, id: &str) -> std::path::PathBuf {
    dir.join(format!("{id}.pdf"))
}

/// A name as it is kept: one line, not too long, never empty.
fn clean_name(name: &str) -> String {
    let one: String = name.chars().filter(|c| !c.is_control()).take(200).collect();
    let one = one.trim();
    if one.is_empty() {
        "Untitled.pdf".to_string()
    } else {
        one.to_string()
    }
}

/// The index. One that cannot be read is not the end of what it listed: the
/// copy kept from before the last write is read in its place, and any PDF
/// in the folder that neither names is listed all the same (under a name
/// that says so), so a file is never there and out of reach.
fn read_index(dir: &std::path::Path) -> Vec<LocalPdfMeta> {
    let parse = |path: std::path::PathBuf| {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<LocalPdfMeta>>(&bytes).ok())
    };
    let mut index: Vec<LocalPdfMeta> = parse(dir.join("index.json"))
        .or_else(|| parse(dir.join("index.json.bak")))
        .unwrap_or_default()
        .into_iter()
        .filter(|m| valid_id(&m.id))
        .collect();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("pdf") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !valid_id(id) || index.iter().any(|m| m.id == id) {
            continue;
        }
        let meta = entry.metadata().ok();
        index.push(LocalPdfMeta {
            id: id.to_string(),
            name: "Recovered.pdf".to_string(),
            bytes: meta.as_ref().map_or(0, |m| m.len()),
            modified_at: meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64),
            deleted_at: None,
        });
    }
    index
}

fn write_index(dir: &std::path::Path, index: &[LocalPdfMeta]) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(index).map_err(std::io::Error::other)?;
    atomic_write(&dir.join("index.json"), &bytes, true)
}

/// What is on the shelf, newest first. Anything taken off it more than
/// thirty days ago is let go here, and an entry whose file is gone is not
/// listed.
pub(crate) fn list_in(dir: &std::path::Path, now: i64) -> std::io::Result<Vec<LocalPdfMeta>> {
    let index = read_index(dir);
    let (old, kept): (Vec<_>, Vec<_>) = index
        .into_iter()
        .partition(|m| m.deleted_at.is_some_and(|at| now - at > KEEP_DELETED_MS));
    if !old.is_empty() {
        for m in &old {
            let _ = std::fs::remove_file(file_of(dir, &m.id));
        }
        write_index(dir, &kept)?;
    }
    let mut shown: Vec<LocalPdfMeta> = kept
        .into_iter()
        .filter(|m| m.deleted_at.is_none() && file_of(dir, &m.id).exists())
        .collect();
    shown.sort_by_key(|m| std::cmp::Reverse(m.modified_at));
    Ok(shown)
}

/// Keep a PDF (a new one, or the one already kept under `id`, written over).
pub(crate) fn write_in(
    dir: &std::path::Path,
    id: &str,
    name: &str,
    bytes: &[u8],
    now: i64,
) -> std::io::Result<LocalPdfMeta> {
    atomic_write(&file_of(dir, id), bytes, false)?;
    let mut index = read_index(dir);
    let meta = LocalPdfMeta {
        id: id.to_string(),
        name: clean_name(name),
        bytes: bytes.len() as u64,
        modified_at: now,
        deleted_at: None,
    };
    index.retain(|m| m.id != id);
    index.push(meta.clone());
    write_index(dir, &index)?;
    Ok(meta)
}

pub(crate) fn read_in(dir: &std::path::Path, id: &str) -> std::io::Result<Vec<u8>> {
    std::fs::read(file_of(dir, id))
}

fn change_in(
    dir: &std::path::Path,
    id: &str,
    f: impl FnOnce(&mut LocalPdfMeta),
) -> std::io::Result<()> {
    let mut index = read_index(dir);
    let Some(entry) = index.iter_mut().find(|m| m.id == id) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no such PDF on this device",
        ));
    };
    f(entry);
    write_index(dir, &index)
}

pub(crate) fn rename_in(dir: &std::path::Path, id: &str, name: &str) -> std::io::Result<()> {
    let name = clean_name(name);
    change_in(dir, id, |m| m.name = name)
}

pub(crate) fn trash_in(dir: &std::path::Path, id: &str, now: i64) -> std::io::Result<()> {
    change_in(dir, id, |m| m.deleted_at = Some(now))
}

pub(crate) fn restore_in(dir: &std::path::Path, id: &str) -> std::io::Result<()> {
    change_in(dir, id, |m| m.deleted_at = None)
}

fn checked(id: &str) -> Result<(), CmdError> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(CmdError::new("bad_id", "invalid PDF id"))
    }
}

#[tauri::command]
pub fn localpdf_list(app: tauri::AppHandle) -> Result<Vec<LocalPdfMeta>, CmdError> {
    list_in(&pdfs_dir(&app)?, now_millis()).map_err(io_err)
}

/// Keep a PDF. The raw body is the file. `x-id` is its id, `x-name` what
/// it is called (percent-encoded).
#[tauri::command]
pub fn localpdf_write(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<LocalPdfMeta, CmdError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CmdError::new("bad_body", "expected the PDF's raw bytes"));
    };
    if bytes.len() > MAX_PDF_BYTES {
        return Err(CmdError::new(
            "too_large",
            "this PDF is too large to keep here",
        ));
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err(CmdError::new("bad_body", "not a PDF"));
    }
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let id = header("x-id").unwrap_or_default();
    checked(&id)?;
    let name = percent_decode(&header("x-name").unwrap_or_default());
    write_in(&pdfs_dir(&app)?, &id, &name, bytes, now_millis()).map_err(io_err)
}

#[tauri::command]
pub fn localpdf_read(app: tauri::AppHandle, id: String) -> Result<tauri::ipc::Response, CmdError> {
    checked(&id)?;
    read_in(&pdfs_dir(&app)?, &id)
        .map(tauri::ipc::Response::new)
        .map_err(|_| CmdError::new("not_found", "that PDF is no longer on this device"))
}

#[tauri::command]
pub fn localpdf_rename(app: tauri::AppHandle, id: String, name: String) -> Result<(), CmdError> {
    checked(&id)?;
    rename_in(&pdfs_dir(&app)?, &id, &name).map_err(io_err)
}

#[tauri::command]
pub fn localpdf_trash(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    checked(&id)?;
    trash_in(&pdfs_dir(&app)?, &id, now_millis()).map_err(io_err)
}

#[tauri::command]
pub fn localpdf_restore(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    checked(&id)?;
    restore_in(&pdfs_dir(&app)?, &id).map_err(io_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wf-localpdfs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_pdf_kept_is_listed_read_back_and_written_over() {
        let dir = temp("keep");
        let a = write_in(&dir, "aa-01", "  Report.pdf\n", b"%PDF-1.7 one", 1_000).unwrap();
        write_in(&dir, "bb-02", "", b"%PDF-1.7 two", 2_000).unwrap();
        assert_eq!(a.name, "Report.pdf");
        let list = list_in(&dir, 3_000).unwrap();
        assert_eq!(
            list.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["bb-02", "aa-01"],
            "newest first"
        );
        assert_eq!(list[0].name, "Untitled.pdf", "a name is never empty");
        assert_eq!(read_in(&dir, "aa-01").unwrap(), b"%PDF-1.7 one");

        write_in(&dir, "aa-01", "Report.pdf", b"%PDF-1.7 one, changed", 4_000).unwrap();
        let list = list_in(&dir, 5_000).unwrap();
        assert_eq!(list.len(), 2, "written over, not kept twice");
        assert_eq!(list[0].id, "aa-01");
        assert_eq!(list[0].bytes, 21);
        assert_eq!(read_in(&dir, "aa-01").unwrap(), b"%PDF-1.7 one, changed");

        rename_in(&dir, "aa-01", "Final report.pdf").unwrap();
        assert_eq!(list_in(&dir, 5_000).unwrap()[0].name, "Final report.pdf");
        assert!(rename_in(&dir, "zz-99", "x").is_err(), "nothing to rename");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_taken_off_the_shelf_waits_thirty_days_and_can_be_put_back() {
        let dir = temp("trash");
        write_in(&dir, "aa-01", "A.pdf", b"%PDF-1.7 a", 1_000).unwrap();
        write_in(&dir, "bb-02", "B.pdf", b"%PDF-1.7 b", 2_000).unwrap();
        trash_in(&dir, "aa-01", 10_000).unwrap();
        assert_eq!(list_in(&dir, 11_000).unwrap().len(), 1);
        assert!(file_of(&dir, "aa-01").exists(), "its file waits");
        restore_in(&dir, "aa-01").unwrap();
        assert_eq!(list_in(&dir, 12_000).unwrap().len(), 2, "put back");

        trash_in(&dir, "aa-01", 20_000).unwrap();
        let later = 20_000 + KEEP_DELETED_MS + 1;
        assert_eq!(list_in(&dir, later).unwrap().len(), 1);
        assert!(!file_of(&dir, "aa-01").exists(), "let go after thirty days");
        assert!(
            restore_in(&dir, "aa-01").is_err(),
            "and no longer to be put back"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_index_or_a_missing_file_hides_nothing_else() {
        let dir = temp("damaged");
        write_in(&dir, "aa-01", "A.pdf", b"%PDF-1.7 a", 1_000).unwrap();
        write_in(&dir, "bb-02", "B.pdf", b"%PDF-1.7 b", 2_000).unwrap();
        write_in(&dir, "cc-03", "C.pdf", b"%PDF-1.7 c", 3_000).unwrap();
        std::fs::remove_file(file_of(&dir, "bb-02")).unwrap();
        let ids = |list: Vec<LocalPdfMeta>| list.into_iter().map(|m| m.id).collect::<Vec<_>>();
        assert_eq!(
            ids(list_in(&dir, 4_000).unwrap()),
            ["cc-03", "aa-01"],
            "an entry whose file is gone is not listed"
        );

        // The index damaged: the copy from before the last write names A and B, and C (in the
        // folder, named by neither) is listed all the same.
        std::fs::write(dir.join("index.json"), b"{ not json").unwrap();
        let list = list_in(&dir, 4_000).unwrap();
        let named = |id: &str| list.iter().find(|m| m.id == id).map(|m| m.name.clone());
        assert_eq!(named("aa-01").as_deref(), Some("A.pdf"));
        assert_eq!(named("cc-03").as_deref(), Some("Recovered.pdf"));
        assert_eq!(list.len(), 2);
        // Keeping another then loses none of them.
        write_in(&dir, "dd-04", "D.pdf", b"%PDF-1.7 d", 5_000).unwrap();
        assert_eq!(list_in(&dir, 6_000).unwrap().len(), 3);
        assert!(!valid_id("../x") && !valid_id("") && valid_id("0a1b-2c"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
