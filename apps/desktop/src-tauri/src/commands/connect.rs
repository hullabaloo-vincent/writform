//! Tauri commands for the connect flow: probe → (trust) → login/register.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use serde::Serialize;
use tauri::State;
use writform_proto::api::{
    AuthResponse, Healthz, LoginRequest, RegisterRequest, ServerIdentity, User,
};

use crate::net;
use crate::servers::{hex, ActiveSession, ConnectionManager, PendingTrust, SavedServer};

/// Errors surfaced to the UI: stable `code` for branching + readable message.
#[derive(Debug, Clone, Serialize)]
pub struct CmdError {
    pub code: String,
    pub message: String,
}

impl CmdError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

type CmdResult<T> = Result<T, CmdError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum TrustStatus {
    /// Pin matches (or cert rotated under the same verified identity).
    Trusted,
    /// Never seen this server; user must approve the fingerprint.
    New { fingerprint: String },
    /// Known server whose IDENTITY KEY changed — possible impostor.
    IdentityChanged {
        fingerprint: String,
        old_fingerprint: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub addr: String,
    pub server_name: String,
    pub protocol_version: u32,
    pub trust: TrustStatus,
}

fn normalize_addr(input: &str) -> CmdResult<String> {
    let trimmed = input
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(CmdError::new("invalid_addr", "enter a server address"));
    }
    Ok(if trimmed.contains(':') {
        trimmed.to_string()
    } else {
        format!("{trimmed}:7311") // default WritForm port
    })
}

async fn fetch_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
) -> CmdResult<T> {
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| CmdError::new("unreachable", format!("could not reach server: {e}")))?;
    if !res.status().is_success() {
        return Err(CmdError::new(
            "bad_status",
            format!("server returned {}", res.status()),
        ));
    }
    res.json::<T>()
        .await
        .map_err(|e| CmdError::new("bad_response", format!("malformed response: {e}")))
}

/// Probe a server: fetch health + identity over a capture handshake, verify
/// the ML-DSA cert binding, and report the trust decision the UI must make.
#[tauri::command]
pub async fn probe_server(
    manager: State<'_, ConnectionManager>,
    addr: String,
) -> CmdResult<ProbeResult> {
    probe_impl(&manager, addr).await
}

pub async fn probe_impl(manager: &ConnectionManager, addr: String) -> CmdResult<ProbeResult> {
    let addr = normalize_addr(&addr)?;
    let verifier = net::PinVerifier::capture();
    let client = net::client_with_verifier(verifier.clone());

    let healthz: Healthz = fetch_json(&client, &format!("https://{addr}/api/v1/healthz")).await?;
    let identity: ServerIdentity =
        fetch_json(&client, &format!("https://{addr}/api/v1/identity")).await?;

    let cert = verifier
        .captured_cert()
        .ok_or_else(|| CmdError::new("no_cert", "no certificate captured during handshake"))?;
    let spki = net::spki_der(&cert).map_err(|e| CmdError::new("bad_cert", e.to_string()))?;

    let pubkey = B64URL
        .decode(&identity.mldsa_pubkey)
        .map_err(|_| CmdError::new("bad_identity", "malformed identity public key"))?;
    let sig = B64URL
        .decode(&identity.cert_binding_sig)
        .map_err(|_| CmdError::new("bad_identity", "malformed cert binding signature"))?;

    // The load-bearing check: the served identity must vouch for the cert we
    // actually saw on the wire. A MITM cannot produce this signature.
    let bound = writform_crypto::identity::verify_cert_binding(&pubkey, &spki, &sig)
        .map_err(|e| CmdError::new("bad_identity", e.to_string()))?;
    if !bound {
        return Err(CmdError::new(
            "binding_invalid",
            "server identity does not vouch for the presented certificate — \
             possible interception, refusing to continue",
        ));
    }

    let identity_hash = hex(&sha2::Sha256::digest(&pubkey));
    let spki_hash = hex(&sha2::Sha256::digest(&spki));
    let fingerprint = writform_crypto::identity::fingerprint(&pubkey);

    let trust = match manager.find(&addr) {
        Some(saved) if saved.identity_hash == identity_hash => {
            // Same identity; silently adopt a rotated cert (binding verified).
            if saved.spki_hash != spki_hash {
                manager.upsert(SavedServer {
                    spki_hash: spki_hash.clone(),
                    server_name: identity.server_name.clone(),
                    ..saved
                });
            }
            TrustStatus::Trusted
        }
        Some(saved) => TrustStatus::IdentityChanged {
            fingerprint: fingerprint.clone(),
            old_fingerprint: saved.fingerprint.clone(),
        },
        None => TrustStatus::New {
            fingerprint: fingerprint.clone(),
        },
    };

    if !matches!(trust, TrustStatus::Trusted) {
        *manager.pending_trust.lock().expect("poisoned") = Some(PendingTrust {
            addr: addr.clone(),
            server_name: identity.server_name.clone(),
            identity_hash,
            spki_hash,
            fingerprint,
        });
    }

    Ok(ProbeResult {
        addr,
        server_name: identity.server_name,
        protocol_version: healthz.protocol_version,
        trust,
    })
}

/// User approved the fingerprint from the last probe — persist the pin.
#[tauri::command]
pub fn trust_server(manager: State<'_, ConnectionManager>, addr: String) -> CmdResult<()> {
    trust_impl(&manager, addr)
}

pub fn trust_impl(manager: &ConnectionManager, addr: String) -> CmdResult<()> {
    let pending = manager
        .pending_trust
        .lock()
        .expect("poisoned")
        .take()
        .filter(|p| p.addr == addr)
        .ok_or_else(|| CmdError::new("no_pending", "no pending trust decision for this server"))?;
    manager.upsert(SavedServer {
        addr: pending.addr,
        server_name: pending.server_name,
        identity_hash: pending.identity_hash,
        spki_hash: pending.spki_hash,
        fingerprint: pending.fingerprint,
        last_username: None,
    });
    Ok(())
}

#[tauri::command]
pub fn list_servers(manager: State<'_, ConnectionManager>) -> Vec<SavedServer> {
    manager.servers.lock().expect("poisoned").clone()
}

#[tauri::command]
pub fn remove_server(manager: State<'_, ConnectionManager>, addr: String) {
    manager.remove(&addr);
}

/// Parse a stored hex SPKI pin into raw bytes.
pub fn pin_for(manager: &ConnectionManager, addr: &str) -> CmdResult<[u8; 32]> {
    let saved = manager
        .find(addr)
        .ok_or_else(|| CmdError::new("not_trusted", "server is not in the trusted list"))?;
    let mut pin = [0u8; 32];
    let bytes = (0..32)
        .map(|i| u8::from_str_radix(&saved.spki_hash[i * 2..i * 2 + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CmdError::new("corrupt_pin", "stored pin is corrupt; remove and re-add"))?;
    pin.copy_from_slice(&bytes);
    Ok(pin)
}

fn pinned_client_for(manager: &ConnectionManager, addr: &str) -> CmdResult<reqwest::Client> {
    Ok(net::client_with_verifier(net::PinVerifier::pinned(
        pin_for(manager, addr)?,
    )))
}

async fn auth_request(
    manager: &ConnectionManager,
    addr: &str,
    path: &str,
    body: serde_json::Value,
) -> CmdResult<AuthResponse> {
    let client = pinned_client_for(manager, addr)?;
    let res = client
        .post(format!("https://{addr}/api/v1/auth/{path}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            // The rustls cause is nested inside reqwest/hyper errors; the
            // debug form carries the whole chain.
            let chain = format!("{e:?}");
            if chain.contains("InvalidCertificate") || chain.contains("certificate") {
                CmdError::new(
                    "pin_mismatch",
                    "server certificate no longer matches the pin",
                )
            } else {
                CmdError::new("unreachable", format!("could not reach server: {e}"))
            }
        })?;

    if !res.status().is_success() {
        let err: writform_proto::api::ApiError =
            res.json()
                .await
                .unwrap_or_else(|_| writform_proto::api::ApiError {
                    code: "unknown".into(),
                    message: "authentication failed".into(),
                });
        return Err(CmdError::new("auth_failed", err.message).with_code(err.code));
    }
    res.json::<AuthResponse>()
        .await
        .map_err(|e| CmdError::new("bad_response", format!("malformed response: {e}")))
}

impl CmdError {
    fn with_code(mut self, code: String) -> Self {
        self.code = code;
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub addr: String,
    pub user: User,
}

#[tauri::command]
pub async fn login(
    app: tauri::AppHandle,
    manager: State<'_, ConnectionManager>,
    ws: State<'_, std::sync::Arc<crate::wsclient::WsManager>>,
    addr: String,
    username: String,
    password: String,
) -> CmdResult<SessionInfo> {
    let info = login_impl(&manager, addr, username, password).await?;
    start_ws_for_active(app, &manager, &ws);
    Ok(info)
}

pub async fn login_impl(
    manager: &ConnectionManager,
    addr: String,
    username: String,
    password: String,
) -> CmdResult<SessionInfo> {
    let addr = normalize_addr(&addr)?;
    let device_label = hostname_label();
    let auth = auth_request(
        manager,
        &addr,
        "login",
        serde_json::to_value(LoginRequest {
            username: username.clone(),
            password,
            device_label,
        })
        .expect("serializable"),
    )
    .await?;
    finish_auth(manager, addr, username, auth)
}

#[tauri::command]
pub async fn register(
    app: tauri::AppHandle,
    manager: State<'_, ConnectionManager>,
    ws: State<'_, std::sync::Arc<crate::wsclient::WsManager>>,
    addr: String,
    username: String,
    password: String,
) -> CmdResult<SessionInfo> {
    let info = register_impl(&manager, addr, username, password).await?;
    start_ws_for_active(app, &manager, &ws);
    Ok(info)
}

/// Open the WS for the just-authenticated session (no-op if pin is missing).
fn start_ws_for_active(
    app: tauri::AppHandle,
    manager: &ConnectionManager,
    ws: &std::sync::Arc<crate::wsclient::WsManager>,
) {
    let (addr, token) = {
        let active = manager.active.lock().expect("poisoned");
        let Some(session) = active.as_ref() else {
            return;
        };
        (session.addr.clone(), session.token.clone())
    };
    match pin_for(manager, &addr) {
        Ok(pin) => crate::wsclient::start(app, ws.clone(), addr, token, pin),
        Err(e) => tracing::error!("cannot start ws: {}", e.message),
    }
}

pub async fn register_impl(
    manager: &ConnectionManager,
    addr: String,
    username: String,
    password: String,
) -> CmdResult<SessionInfo> {
    let addr = normalize_addr(&addr)?;
    let auth = auth_request(
        manager,
        &addr,
        "register",
        serde_json::to_value(RegisterRequest {
            username: username.clone(),
            password,
        })
        .expect("serializable"),
    )
    .await?;
    finish_auth(manager, addr, username, auth)
}

fn finish_auth(
    manager: &ConnectionManager,
    addr: String,
    username: String,
    auth: AuthResponse,
) -> CmdResult<SessionInfo> {
    if let Some(mut saved) = manager.find(&addr) {
        saved.last_username = Some(username);
        manager.upsert(saved);
    }
    let client = pinned_client_for(manager, &addr)?;
    let info = SessionInfo {
        addr: addr.clone(),
        user: auth.user.clone(),
    };
    *manager.active.lock().expect("poisoned") = Some(ActiveSession {
        addr,
        client,
        token: auth.token,
        user: auth.user,
    });
    Ok(info)
}

#[tauri::command]
pub async fn logout(
    manager: State<'_, ConnectionManager>,
    ws: State<'_, std::sync::Arc<crate::wsclient::WsManager>>,
) -> CmdResult<()> {
    ws.disconnect();
    let session = manager.active.lock().expect("poisoned").take();
    if let Some(s) = session {
        // Best-effort server-side revocation; local logout succeeds regardless.
        let _ = s
            .client
            .post(format!("https://{}/api/v1/auth/logout", s.addr))
            .bearer_auth(&s.token)
            .send()
            .await;
    }
    Ok(())
}

#[tauri::command]
pub fn current_session(manager: State<'_, ConnectionManager>) -> Option<SessionInfo> {
    manager
        .active
        .lock()
        .expect("poisoned")
        .as_ref()
        .map(|s| SessionInfo {
            addr: s.addr.clone(),
            user: s.user.clone(),
        })
}

fn hostname_label() -> Option<String> {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
}

use sha2::Digest;

/// Redeem an admin-issued one-time reset code for a new password. Pre-auth:
/// rides the pinned TLS client for a saved server, no session required.
#[tauri::command]
pub async fn reset_password(
    manager: State<'_, ConnectionManager>,
    addr: String,
    username: String,
    code: String,
    new_password: String,
) -> CmdResult<()> {
    let addr = normalize_addr(&addr)?;
    let client = pinned_client_for(&manager, &addr)?;
    let res = client
        .post(format!("https://{addr}/api/v1/auth/reset-password"))
        .json(&serde_json::json!({
            "username": username,
            "code": code,
            "new_password": new_password,
        }))
        .send()
        .await
        .map_err(|e| CmdError::new("unreachable", format!("could not reach server: {e}")))?;
    if !res.status().is_success() {
        let err: writform_proto::api::ApiError =
            res.json()
                .await
                .unwrap_or_else(|_| writform_proto::api::ApiError {
                    code: "unknown".into(),
                    message: "password reset failed".into(),
                });
        return Err(CmdError::new("reset_failed", err.message).with_code(err.code));
    }
    Ok(())
}
