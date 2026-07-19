//! Saved-server list (TOFU pins) and the active connection.
//!
//! Persisted as JSON at `{app_config_dir}/servers.json`. The real pin is the
//! ML-DSA identity key hash; the SPKI hash is a fast path that lets the TLS
//! handshake itself reject impostors. If the cert rotates but the identity
//! key still verifies the new cert's binding, the SPKI pin is updated
//! silently — an identity-key change is a loud trust decision for the user.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedServer {
    /// `host:port` as the user entered it.
    pub addr: String,
    pub server_name: String,
    /// SHA-256 of the ML-DSA-65 public key, hex — the durable pin.
    pub identity_hash: String,
    /// SHA-256 of the current cert's SPKI, hex — the TLS-level pin.
    pub spki_hash: String,
    /// Human-checkable fingerprint shown at trust time.
    pub fingerprint: String,
    pub last_username: Option<String>,
}

/// Result of a probe, held until the user accepts trust.
#[derive(Debug, Clone)]
pub struct PendingTrust {
    pub addr: String,
    pub server_name: String,
    pub identity_hash: String,
    pub spki_hash: String,
    pub fingerprint: String,
}

/// The authenticated connection to one server (single active server for now).
pub struct ActiveSession {
    pub addr: String,
    pub client: reqwest::Client,
    pub token: String,
    pub user: writform_proto::api::User,
}

#[derive(Default)]
pub struct ConnectionManager {
    pub config_path: Mutex<Option<PathBuf>>,
    pub servers: Mutex<Vec<SavedServer>>,
    pub pending_trust: Mutex<Option<PendingTrust>>,
    pub active: Mutex<Option<ActiveSession>>,
}

impl ConnectionManager {
    pub fn load(&self, config_dir: PathBuf) {
        let path = config_dir.join("servers.json");
        if let Ok(bytes) = std::fs::read(&path) {
            match serde_json::from_slice::<Vec<SavedServer>>(&bytes) {
                Ok(list) => *self.servers.lock().expect("poisoned") = list,
                Err(e) => tracing::warn!("ignoring corrupt servers.json: {e}"),
            }
        }
        *self.config_path.lock().expect("poisoned") = Some(path);
    }

    pub fn persist(&self) {
        let path = self.config_path.lock().expect("poisoned").clone();
        let Some(path) = path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let servers = self.servers.lock().expect("poisoned").clone();
        match serde_json::to_vec_pretty(&servers) {
            Ok(bytes) => {
                if let Err(e) = std::fs::write(&path, bytes) {
                    tracing::error!("failed to write servers.json: {e}");
                }
            }
            Err(e) => tracing::error!("failed to serialize servers.json: {e}"),
        }
    }

    pub fn find(&self, addr: &str) -> Option<SavedServer> {
        self.servers
            .lock()
            .expect("poisoned")
            .iter()
            .find(|s| s.addr == addr)
            .cloned()
    }

    pub fn upsert(&self, server: SavedServer) {
        {
            let mut servers = self.servers.lock().expect("poisoned");
            if let Some(existing) = servers.iter_mut().find(|s| s.addr == server.addr) {
                *existing = server;
            } else {
                servers.push(server);
            }
        }
        self.persist();
    }

    pub fn remove(&self, addr: &str) {
        self.servers
            .lock()
            .expect("poisoned")
            .retain(|s| s.addr != addr);
        self.persist();
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
