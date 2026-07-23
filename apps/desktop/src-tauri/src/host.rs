//! "Host on this computer": runs a full subScribe server inside the desktop
//! app, so a user can create a server without touching a terminal.
//!
//! The hosted server is identical to the standalone binary (same crate, same
//! data layout), with its data under `{app_data_dir}/server/`. Because this
//! process owns the identity key, the local client pins it directly — no
//! TOFU prompt for your own server. Friends connecting from elsewhere still
//! verify the fingerprint as usual.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::Digest;
use tauri::Manager;

use crate::commands::connect::CmdError;
use crate::servers::{hex, ConnectionManager, SavedServer};

/// Persisted at `{app_config_dir}/host.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostConfig {
    pub port: u16,
    pub server_name: String,
    /// Start the server automatically when the app launches.
    pub auto_start: bool,
}

pub const DEFAULT_PORT: u16 = 7311;

struct RunningHost {
    port: u16,
    fingerprint: String,
    server: Option<writform_server::serve::StartedServer>,
}

#[derive(Default)]
pub struct HostManager {
    config_path: Mutex<Option<PathBuf>>,
    data_dir: Mutex<Option<PathBuf>>,
    running: Mutex<Option<RunningHost>>,
}

impl HostManager {
    pub fn init(&self, config_dir: PathBuf, data_dir: PathBuf) {
        *self.config_path.lock().expect("poisoned") = Some(config_dir.join("host.json"));
        *self.data_dir.lock().expect("poisoned") = Some(data_dir.join("server"));
    }

    pub fn config(&self) -> Option<HostConfig> {
        let path = self.config_path.lock().expect("poisoned").clone()?;
        let bytes = std::fs::read(path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    fn save_config(&self, config: &HostConfig) {
        let Some(path) = self.config_path.lock().expect("poisoned").clone() else {
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match serde_json::to_vec_pretty(config) {
            Ok(bytes) => {
                if let Err(e) = std::fs::write(&path, bytes) {
                    tracing::error!("failed to write host.json: {e}");
                }
            }
            Err(e) => tracing::error!("failed to serialize host.json: {e}"),
        }
    }

    fn server_data_dir(&self) -> Result<PathBuf, CmdError> {
        self.data_dir
            .lock()
            .expect("poisoned")
            .clone()
            .ok_or_else(|| CmdError::new("no_data_dir", "app data directory unavailable"))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HostStatus {
    /// A hosted server has been set up on this machine (host.json exists).
    pub configured: bool,
    pub running: bool,
    pub port: u16,
    pub server_name: String,
    /// Loopback address the local client connects to, when running.
    pub addr: Option<String>,
    pub fingerprint: Option<String>,
    /// LAN addresses friends on the same network can use.
    pub lan_addrs: Vec<String>,
}

fn status_of(host: &HostManager) -> HostStatus {
    let config = host.config();
    let running = host.running.lock().expect("poisoned");
    let (port, server_name) = match &config {
        Some(c) => (c.port, c.server_name.clone()),
        None => (DEFAULT_PORT, "My subScribe Server".to_string()),
    };
    match running.as_ref() {
        Some(r) => HostStatus {
            configured: config.is_some(),
            running: true,
            port: r.port,
            server_name,
            addr: Some(format!("127.0.0.1:{}", r.port)),
            fingerprint: Some(r.fingerprint.clone()),
            lan_addrs: lan_addrs(r.port),
        },
        None => HostStatus {
            configured: config.is_some(),
            running: false,
            port,
            server_name,
            addr: None,
            fingerprint: None,
            lan_addrs: vec![],
        },
    }
}

/// Non-loopback, non-link-local IPv4 addresses of this machine.
fn lan_addrs(port: u16) -> Vec<String> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return vec![];
    };
    interfaces
        .into_iter()
        .filter(|i| !i.is_loopback() && !i.is_link_local())
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) => Some(format!("{ip}:{port}")),
            IpAddr::V6(_) => None,
        })
        .collect()
}

#[tauri::command]
pub fn host_status(host: tauri::State<'_, HostManager>) -> HostStatus {
    status_of(&host)
}

/// Start (or ensure) the hosted server and pin it for the local client.
#[tauri::command]
pub async fn host_start(
    host: tauri::State<'_, HostManager>,
    conn: tauri::State<'_, ConnectionManager>,
    port: u16,
    server_name: String,
) -> Result<HostStatus, CmdError> {
    start_impl(&host, &conn, port, server_name).await
}

pub async fn start_impl(
    host: &HostManager,
    conn: &ConnectionManager,
    port: u16,
    server_name: String,
) -> Result<HostStatus, CmdError> {
    let server_name = {
        let trimmed = server_name.trim();
        if trimmed.is_empty() {
            "My subScribe Server".to_string()
        } else {
            trimmed.to_string()
        }
    };

    if host.running.lock().expect("poisoned").is_some() {
        return Ok(status_of(host));
    }

    let data_dir = host.server_data_dir()?;
    let started = writform_server::serve::start(writform_server::serve::ServeOptions {
        data_dir,
        bind: "0.0.0.0".to_string(),
        port,
        server_name: server_name.clone(),
        web_dir: None,
    })
    .await
    .map_err(|e| {
        CmdError::new(
            "host_start_failed",
            format!("could not start server: {e:#}"),
        )
    })?;

    let identity_hash = hex(&sha2::Sha256::digest(&started.identity_pubkey));
    let spki_hash = hex(&sha2::Sha256::digest(&started.spki_der));
    let fingerprint = started.fingerprint.clone();
    let addr = format!("127.0.0.1:{}", started.local_addr.port());

    // Pin our own server for the local client — trust is implicit.
    conn.upsert(SavedServer {
        addr,
        server_name: server_name.clone(),
        identity_hash,
        spki_hash,
        fingerprint: fingerprint.clone(),
        last_username: conn
            .find(&format!("127.0.0.1:{}", started.local_addr.port()))
            .and_then(|s| s.last_username),
    });

    let actual_port = started.local_addr.port();
    *host.running.lock().expect("poisoned") = Some(RunningHost {
        port: actual_port,
        fingerprint,
        server: Some(started),
    });
    host.save_config(&HostConfig {
        port: actual_port,
        server_name,
        auto_start: true,
    });

    Ok(status_of(host))
}

/// Stop the hosted server and disable auto-start.
#[tauri::command]
pub async fn host_stop(host: tauri::State<'_, HostManager>) -> Result<HostStatus, CmdError> {
    let server = {
        let mut running = host.running.lock().expect("poisoned");
        running.take().and_then(|mut r| r.server.take())
    };
    if let Some(server) = server {
        server.shutdown().await;
    }
    if let Some(mut config) = host.config() {
        config.auto_start = false;
        host.save_config(&config);
    }
    Ok(status_of(&host))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum UpnpResult {
    /// The router mapped the port; the server is reachable at `external_addr`.
    Mapped { external_addr: String },
    /// No UPnP-capable router answered, or it refused the mapping.
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct Reachability {
    pub lan_addrs: Vec<String>,
    pub upnp: UpnpResult,
}

/// Try to make the hosted server reachable from the internet by asking the
/// router (UPnP IGD) to forward the port. Best-effort: many networks have
/// UPnP disabled, in which case the UI shows manual guidance instead.
#[tauri::command]
pub async fn host_reachability(
    host: tauri::State<'_, HostManager>,
) -> Result<Reachability, CmdError> {
    let port = host
        .running
        .lock()
        .expect("poisoned")
        .as_ref()
        .map(|r| r.port)
        .ok_or_else(|| CmdError::new("not_running", "the hosted server is not running"))?;
    let lan = lan_addrs(port);
    let upnp = try_upnp(port, &lan).await;
    Ok(Reachability {
        lan_addrs: lan,
        upnp,
    })
}

async fn try_upnp(port: u16, lan: &[String]) -> UpnpResult {
    let Some(local_ip) = lan
        .first()
        .and_then(|a| a.split(':').next())
        .and_then(|ip| ip.parse::<IpAddr>().ok())
    else {
        return UpnpResult::Failed {
            message: "no LAN address found on this machine".to_string(),
        };
    };

    let search = igd_next::aio::tokio::search_gateway(igd_next::SearchOptions {
        timeout: Some(std::time::Duration::from_secs(3)),
        ..Default::default()
    });
    let gateway = match tokio::time::timeout(std::time::Duration::from_secs(5), search).await {
        Ok(Ok(gw)) => gw,
        Ok(Err(e)) => {
            return UpnpResult::Failed {
                message: format!("no UPnP router found: {e}"),
            }
        }
        Err(_) => {
            return UpnpResult::Failed {
                message: "no UPnP router found (search timed out)".to_string(),
            }
        }
    };

    let local_addr = SocketAddr::new(local_ip, port);
    if let Err(e) = gateway
        .add_port(
            igd_next::PortMappingProtocol::TCP,
            port,
            local_addr,
            0, // permanent lease; removed on Stop hosting
            "subScribe",
        )
        .await
    {
        return UpnpResult::Failed {
            message: format!("router refused the port mapping: {e}"),
        };
    }

    match gateway.get_external_ip().await {
        Ok(external_ip) => UpnpResult::Mapped {
            external_addr: format!("{external_ip}:{port}"),
        },
        Err(e) => UpnpResult::Failed {
            message: format!("port mapped but could not read external address: {e}"),
        },
    }
}

/// On app launch: restart the hosted server if the user set one up.
pub fn auto_start(app: &tauri::AppHandle) {
    let host = app.state::<HostManager>();
    let Some(config) = host.config() else { return };
    if !config.auto_start {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let host = app.state::<HostManager>();
        let conn = app.state::<ConnectionManager>();
        match start_impl(&host, &conn, config.port, config.server_name).await {
            Ok(status) => tracing::info!(
                "hosted server auto-started on port {} ({})",
                status.port,
                status.fingerprint.unwrap_or_default()
            ),
            Err(e) => tracing::error!("hosted server auto-start failed: {}", e.message),
        }
    });
}
