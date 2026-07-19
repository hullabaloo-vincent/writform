//! Third-party plugin loader. A plugin is a folder in
//! `{app_data_dir}/plugins/<id>/` containing `manifest.json` and `main.js`.
//! The Rust core only reads plugin files and tracks the enabled set; the
//! permission-scoped API surface is constructed in the platform layer
//! (see docs/plugin-api.md for the honest security model).

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::commands::connect::CmdError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default = "default_min_api")]
    pub min_api_version: u32,
}

fn default_min_api() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize)]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    pub enabled: bool,
}

fn io_err(e: impl std::fmt::Display) -> CmdError {
    CmdError {
        code: "io".into(),
        message: e.to_string(),
    }
}

fn plugins_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CmdError> {
    let dir = app.path().app_data_dir().map_err(io_err)?.join("plugins");
    std::fs::create_dir_all(&dir).map_err(io_err)?;
    Ok(dir)
}

fn enabled_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CmdError> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(io_err)?
        .join("plugins-enabled.json"))
}

fn read_enabled(app: &tauri::AppHandle) -> Vec<String> {
    enabled_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

#[tauri::command]
pub fn plugins_list(app: tauri::AppHandle) -> Result<Vec<InstalledPlugin>, CmdError> {
    let dir = plugins_dir(&app)?;
    let enabled = read_enabled(&app);
    let mut plugins = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(io_err)? {
        let entry = entry.map_err(io_err)?;
        if !entry.path().is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        let Ok(bytes) = std::fs::read(&manifest_path) else {
            continue;
        };
        match serde_json::from_slice::<PluginManifest>(&bytes) {
            Ok(manifest) => {
                // The manifest id must match its folder and be filesystem-safe.
                let folder = entry.file_name().to_string_lossy().to_string();
                if manifest.id != folder || !valid_id(&manifest.id) {
                    tracing::warn!("plugin folder {folder}: id mismatch or invalid, skipping");
                    continue;
                }
                let enabled = enabled.contains(&manifest.id);
                plugins.push(InstalledPlugin { manifest, enabled });
            }
            Err(e) => tracing::warn!("bad plugin manifest {}: {e}", manifest_path.display()),
        }
    }
    plugins.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    Ok(plugins)
}

/// Source of an ENABLED plugin's entry file (the platform layer evaluates it
/// only after the user granted its permissions at enable time).
#[tauri::command]
pub fn plugin_read_entry(app: tauri::AppHandle, id: String) -> Result<String, CmdError> {
    if !valid_id(&id) {
        return Err(CmdError {
            code: "bad_id".into(),
            message: "invalid plugin id".into(),
        });
    }
    if !read_enabled(&app).contains(&id) {
        return Err(CmdError {
            code: "not_enabled".into(),
            message: "plugin is not enabled".into(),
        });
    }
    std::fs::read_to_string(plugins_dir(&app)?.join(&id).join("main.js")).map_err(io_err)
}

#[tauri::command]
pub fn plugin_set_enabled(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), CmdError> {
    if !valid_id(&id) {
        return Err(CmdError {
            code: "bad_id".into(),
            message: "invalid plugin id".into(),
        });
    }
    let mut list = read_enabled(&app);
    list.retain(|p| p != &id);
    if enabled {
        list.push(id);
    }
    let path = enabled_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(io_err)?;
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&list).map_err(io_err)?).map_err(io_err)
}
