//! Tauri commands for the connect flow: probe → (trust) → login/register.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use serde::Serialize;
use tauri::State;
use writform_proto::api::{
    AuthResponse, Healthz, IdentityProof, IdentityProofRequest, LoginRequest, RegisterRequest,
    Registration, ServerIdentity, User,
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
    /// Reached through a proxy (its certificate a public one, not the
    /// server's own): the server proved its identity over a nonce instead.
    pub via_proxy: bool,
    /// Who may make an account there (None: an older server, anyone).
    pub registration: Option<Registration>,
}

fn normalize_addr(input: &str) -> CmdResult<String> {
    Ok(addr_candidates(input)?.remove(0))
}

/// Where to look for a server, in order. A port given is the one. Without
/// one, `https://` means 443 (a proxy's port), and a bare name tries the
/// server's own 7311 and then 443.
fn addr_candidates(input: &str) -> CmdResult<Vec<String>> {
    let raw = input.trim();
    let https = raw.starts_with("https://");
    let trimmed = raw
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    // (Anything after the host is not part of the address.)
    let trimmed = trimmed.split('/').next().unwrap_or("").trim();
    if trimmed.is_empty() {
        return Err(CmdError::new("invalid_addr", "enter a server address"));
    }
    // A port: the last colon outside an IPv6 address's brackets.
    let has_port = match trimmed.rfind(':') {
        Some(i) => {
            !trimmed[..i].is_empty() && (!trimmed.starts_with('[') || trimmed[..i].ends_with(']'))
        }
        None => false,
    };
    Ok(if has_port {
        vec![trimmed.to_string()]
    } else if https {
        vec![format!("{trimmed}:443")]
    } else {
        vec![format!("{trimmed}:7311"), format!("{trimmed}:443")]
    })
}

/// Ask a server to prove it holds the identity key whose hash is pinned,
/// over a fresh nonce, before anything private is sent to it through a
/// proxy. `pubkey`: the key, when the caller has it already.
pub async fn prove_identity(
    client: &reqwest::Client,
    addr: &str,
    identity_hash: &str,
    pubkey: Option<&[u8]>,
) -> CmdResult<()> {
    let fetched;
    let key = match pubkey {
        Some(k) => k,
        None => {
            let identity: ServerIdentity =
                fetch_json(client, &format!("https://{addr}/api/v1/identity")).await?;
            fetched = B64URL
                .decode(&identity.mldsa_pubkey)
                .map_err(|_| CmdError::new("bad_identity", "malformed identity public key"))?;
            &fetched
        }
    };
    if hex(&sha2::Sha256::digest(key)) != identity_hash {
        return Err(CmdError::new(
            "identity_changed",
            "this server's identity isn't the one you trusted, so the connection is refused",
        ));
    }
    let nonce = net::random_bytes::<32>();
    let res = client
        .post(format!("https://{addr}/api/v1/identity/proof"))
        .json(&IdentityProofRequest {
            nonce: B64URL.encode(nonce),
        })
        .send()
        .await
        .map_err(|e| CmdError::new("unreachable", format!("could not reach server: {e}")))?;
    if !res.status().is_success() {
        return Err(CmdError::new(
            "binding_invalid",
            "the server couldn't prove its identity, so the connection is refused",
        ));
    }
    let proof: IdentityProof = res
        .json()
        .await
        .map_err(|e| CmdError::new("bad_response", format!("malformed response: {e}")))?;
    let sig = B64URL
        .decode(&proof.sig)
        .map_err(|_| CmdError::new("bad_identity", "malformed identity proof"))?;
    match writform_crypto::identity::verify_identity_proof(key, &nonce, &sig) {
        Ok(true) => Ok(()),
        _ => Err(CmdError::new("binding_invalid", "the server couldn't prove its identity (possible interception), so the connection is refused")),
    }
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
    let candidates = addr_candidates(&addr)?;
    let mut last = None;
    for (i, addr) in candidates.iter().enumerate() {
        match probe_at(manager, addr.clone()).await {
            // Nothing there: the next place, if there is one.
            Err(e) if e.code == "unreachable" && i + 1 < candidates.len() => last = Some(e),
            other => return other,
        }
    }
    Err(last.unwrap_or_else(|| CmdError::new("unreachable", "could not reach server")))
}

async fn probe_at(manager: &ConnectionManager, addr: String) -> CmdResult<ProbeResult> {
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
    let identity_hash = hex(&sha2::Sha256::digest(&pubkey));
    // Not its own certificate: a proxy's (Cloudflare, a tunnel), which the
    // public roots must vouch for, and the server proves its identity over a
    // nonce through it.
    let via_proxy = !bound;
    if via_proxy {
        let public = net::client_with_verifier(net::PinVerifier::public());
        if let Err(e) = prove_identity(&public, &addr, &identity_hash, Some(&pubkey)).await {
            return Err(if e.code == "unreachable" || e.code == "binding_invalid" {
                CmdError::new(
                    "binding_invalid",
                    "server identity does not vouch for the presented certificate, and the certificate isn't \
                     a valid public one with the server's proof of identity (possible interception), so the \
                     connection is refused",
                )
            } else {
                e
            });
        }
    }
    let spki_hash = if via_proxy {
        net::PUBLIC_PIN.to_string()
    } else {
        hex(&sha2::Sha256::digest(&spki))
    };
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
        via_proxy,
        registration: healthz.registration,
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
        session_token: None,
        last_active_at: None,
        paused: false,
    });
    Ok(())
}

/// A saved server as the UI lists it: never its token, but whether one is
/// kept (so "Connect" can skip the password).
#[derive(Debug, Clone, Serialize)]
pub struct ServerListing {
    #[serde(flatten)]
    pub server: SavedServer,
    pub signed_in: bool,
}

#[tauri::command]
pub fn list_servers(manager: State<'_, ConnectionManager>) -> Vec<ServerListing> {
    list_impl(&manager)
}

pub fn list_impl(manager: &ConnectionManager) -> Vec<ServerListing> {
    manager
        .servers
        .lock()
        .expect("poisoned")
        .iter()
        // The token never crosses into the webview; the UI only needs to
        // know the server can be resumed.
        .map(|s| ServerListing {
            signed_in: s.session_token.is_some(),
            server: SavedServer {
                session_token: None,
                ..s.clone()
            },
        })
        .collect()
}

#[tauri::command]
pub fn remove_server(manager: State<'_, ConnectionManager>, addr: String) {
    manager.remove(&addr);
}

/// How a saved server's connection is trusted: its stored SPKI pin, or a
/// public certificate (a server reached through a proxy).
pub fn pin_for(manager: &ConnectionManager, addr: &str) -> CmdResult<net::Trust> {
    let saved = manager
        .find(addr)
        .ok_or_else(|| CmdError::new("not_trusted", "server is not in the trusted list"))?;
    if saved.spki_hash == net::PUBLIC_PIN {
        return Ok(net::Trust::Public);
    }
    let mut pin = [0u8; 32];
    let bytes = (0..32)
        .map(|i| u8::from_str_radix(&saved.spki_hash[i * 2..i * 2 + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| {
            CmdError::new(
                "corrupt_pin",
                "stored pin is corrupt, so remove the server and add it again",
            )
        })?;
    pin.copy_from_slice(&bytes);
    Ok(net::Trust::Pinned(pin))
}

fn pinned_client_for(manager: &ConnectionManager, addr: &str) -> CmdResult<reqwest::Client> {
    Ok(net::client_with_verifier(net::PinVerifier::for_trust(
        pin_for(manager, addr)?,
    )))
}

/// A client for a saved server, ready for something private: through a
/// proxy, the server has just proved its identity on it.
async fn proven_client_for(manager: &ConnectionManager, addr: &str) -> CmdResult<reqwest::Client> {
    let client = pinned_client_for(manager, addr)?;
    if pin_for(manager, addr)? == net::Trust::Public {
        let saved = manager
            .find(addr)
            .ok_or_else(|| CmdError::new("not_trusted", "server is not in the trusted list"))?;
        prove_identity(&client, addr, &saved.identity_hash, None).await?;
    }
    Ok(client)
}

async fn auth_request(
    manager: &ConnectionManager,
    addr: &str,
    path: &str,
    body: serde_json::Value,
) -> CmdResult<AuthResponse> {
    // (Through a proxy, no password goes until the server has proved itself.)
    let client = proven_client_for(manager, addr).await?;
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
    remember: bool,
) -> CmdResult<SessionInfo> {
    let info = login_impl(&manager, addr, username, password, remember).await?;
    // Switching servers: the old socket and the rooms it was subscribed to
    // belong to the server being left.
    ws.disconnect();
    start_ws_for_active(app, &manager, &ws);
    Ok(info)
}

pub async fn login_impl(
    manager: &ConnectionManager,
    addr: String,
    username: String,
    password: String,
    remember: bool,
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
    finish_auth(manager, addr, username, auth, remember)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // (a command's arguments are the call's fields)
pub async fn register(
    app: tauri::AppHandle,
    manager: State<'_, ConnectionManager>,
    ws: State<'_, std::sync::Arc<crate::wsclient::WsManager>>,
    addr: String,
    username: String,
    password: String,
    remember: bool,
    invite: Option<String>,
) -> CmdResult<SessionInfo> {
    let info = register_impl(&manager, addr, username, password, remember, invite).await?;
    ws.disconnect();
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
        Ok(trust) => crate::wsclient::start(app, ws.clone(), addr, token, trust),
        Err(e) => tracing::error!("cannot start ws: {}", e.message),
    }
}

pub async fn register_impl(
    manager: &ConnectionManager,
    addr: String,
    username: String,
    password: String,
    remember: bool,
    invite: Option<String>,
) -> CmdResult<SessionInfo> {
    let addr = normalize_addr(&addr)?;
    let auth = auth_request(
        manager,
        &addr,
        "register",
        serde_json::to_value(RegisterRequest {
            username: username.clone(),
            password,
            invite: invite
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty()),
        })
        .expect("serializable"),
    )
    .await?;
    finish_auth(manager, addr, username, auth, remember)
}

fn finish_auth(
    manager: &ConnectionManager,
    addr: String,
    username: String,
    auth: AuthResponse,
    remember: bool,
) -> CmdResult<SessionInfo> {
    if let Some(mut saved) = manager.find(&addr) {
        saved.last_username = Some(username);
        // Unchecking "Remember me" is a statement of intent: drop any token
        // a previous login left behind.
        saved.session_token = remember.then(|| auth.token.clone());
        saved.last_active_at = Some(now_ms());
        saved.paused = false;
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
        // An explicit logout also forgets the remembered token.
        if let Some(mut saved) = manager.find(&s.addr) {
            saved.session_token = None;
            manager.upsert(saved);
        }
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

/// Leave the server without signing out: the socket closes and nothing is
/// connected, but the remembered token stays, so coming back is one click
/// (see `resume_server`). Launch won't reconnect by itself until then.
#[tauri::command]
pub fn disconnect(
    manager: State<'_, ConnectionManager>,
    ws: State<'_, std::sync::Arc<crate::wsclient::WsManager>>,
) {
    ws.disconnect();
    disconnect_impl(&manager);
}

pub fn disconnect_impl(manager: &ConnectionManager) {
    let session = manager.active.lock().expect("poisoned").take();
    if let Some(s) = session {
        if let Some(mut saved) = manager.find(&s.addr) {
            saved.paused = true;
            manager.upsert(saved);
        }
    }
}

/// What a resume produced: a live session, or why there isn't one.
/// `reason` is "expired" (stored token rejected — show the login with a
/// notice) or "unreachable" (server down; the token is kept for next time).
#[derive(Debug, Clone, Serialize)]
pub struct ResumeResult {
    pub session: Option<SessionInfo>,
    pub reason: Option<String>,
    pub addr: Option<String>,
}

impl ResumeResult {
    fn none() -> Self {
        Self {
            session: None,
            reason: None,
            addr: None,
        }
    }

    fn failed(reason: &str, addr: String) -> Self {
        Self {
            session: None,
            reason: Some(reason.into()),
            addr: Some(addr),
        }
    }
}

/// Which server launch would resume — a file read, no network — so the app
/// can open at once and say "reconnecting to …" while `current_session`
/// does the asking.
#[derive(Debug, Clone, Serialize)]
pub struct ResumeTarget {
    pub addr: String,
    pub server_name: String,
    pub last_username: Option<String>,
}

fn resume_candidate(manager: &ConnectionManager) -> Option<SavedServer> {
    manager
        .servers
        .lock()
        .expect("poisoned")
        .iter()
        .filter(|s| s.session_token.is_some() && !s.paused)
        .max_by_key(|s| s.last_active_at.unwrap_or(0))
        .cloned()
}

#[tauri::command]
pub fn resume_target(manager: State<'_, ConnectionManager>) -> Option<ResumeTarget> {
    target_impl(&manager)
}

pub fn target_impl(manager: &ConnectionManager) -> Option<ResumeTarget> {
    if manager.active.lock().expect("poisoned").is_some() {
        return None;
    }
    resume_candidate(manager).map(|s| ResumeTarget {
        addr: s.addr,
        server_name: s.server_name,
        last_username: s.last_username,
    })
}

/// How long one resume attempt may take. A server that doesn't answer in
/// this time is treated as unreachable; the app is already open by then.
const RESUME_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Ask a saved server whether its remembered token still stands, and make
/// it the active session if so. `patience` keeps trying through connection
/// failures for that long — for the server this app hosts, which may still
/// be starting when launch gets here.
pub async fn resume_impl(
    manager: &ConnectionManager,
    saved: SavedServer,
    patience: std::time::Duration,
) -> ResumeResult {
    let Some(token) = saved.session_token.clone() else {
        return ResumeResult::none();
    };
    let Ok(client) = pinned_client_for(manager, &saved.addr) else {
        return ResumeResult::none();
    };
    // Through a proxy: the server proves itself before the token goes.
    if pin_for(manager, &saved.addr).ok() == Some(net::Trust::Public) {
        if let Err(e) = prove_identity(&client, &saved.addr, &saved.identity_hash, None).await {
            tracing::warn!("resume: {}", e.message);
            return ResumeResult::failed("unreachable", saved.addr.clone());
        }
    }
    let started = std::time::Instant::now();
    let res = loop {
        let attempt = client
            .get(format!("https://{}/api/v1/auth/me", saved.addr))
            .bearer_auth(&token)
            .timeout(RESUME_TIMEOUT)
            .send()
            .await;
        match attempt {
            Err(e) if e.is_connect() && started.elapsed() < patience => {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
            other => break other,
        }
    };
    match res {
        Ok(r) if r.status().is_success() => match r.json::<User>().await {
            Ok(user) => {
                let mut refreshed = manager.find(&saved.addr).unwrap_or_else(|| saved.clone());
                refreshed.last_active_at = Some(now_ms());
                refreshed.paused = false;
                manager.upsert(refreshed);
                let info = SessionInfo {
                    addr: saved.addr.clone(),
                    user: user.clone(),
                };
                *manager.active.lock().expect("poisoned") = Some(ActiveSession {
                    addr: saved.addr,
                    client,
                    token,
                    user,
                });
                ResumeResult {
                    session: Some(info),
                    reason: None,
                    addr: None,
                }
            }
            Err(_) => ResumeResult::failed("unreachable", saved.addr),
        },
        Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => {
            // The token is dead (expired or revoked) — forget it and say so,
            // so this server's login can open with a notice.
            if let Some(mut cleared) = manager.find(&saved.addr) {
                cleared.session_token = None;
                manager.upsert(cleared);
            }
            ResumeResult::failed("expired", saved.addr)
        }
        _ => ResumeResult::failed("unreachable", saved.addr),
    }
}

/// How long launch waits on the server this app hosts to come up.
const OWN_SERVER_PATIENCE: std::time::Duration = std::time::Duration::from_secs(6);

fn patience_for(host: &crate::host::HostManager, addr: &str) -> std::time::Duration {
    if host.local_addr().as_deref() == Some(addr) {
        OWN_SERVER_PATIENCE
    } else {
        std::time::Duration::ZERO
    }
}

/// Launch: the session already in memory (a dev reload), or the most
/// recently used server that kept a token and wasn't left on purpose.
#[tauri::command]
pub async fn current_session(
    app: tauri::AppHandle,
    manager: State<'_, ConnectionManager>,
    host: State<'_, crate::host::HostManager>,
    ws: State<'_, std::sync::Arc<crate::wsclient::WsManager>>,
) -> CmdResult<ResumeResult> {
    let in_memory = manager
        .active
        .lock()
        .expect("poisoned")
        .as_ref()
        .map(|s| SessionInfo {
            addr: s.addr.clone(),
            user: s.user.clone(),
        });
    if let Some(session) = in_memory {
        return Ok(ResumeResult {
            session: Some(session),
            reason: None,
            addr: None,
        });
    }
    let Some(saved) = resume_candidate(&manager) else {
        return Ok(ResumeResult::none());
    };
    let patience = patience_for(&host, &saved.addr);
    let result = resume_impl(&manager, saved, patience).await;
    if result.session.is_some() {
        ws.disconnect();
        start_ws_for_active(app, &manager, &ws);
    }
    Ok(result)
}

/// Come back to a saved server with its remembered token (after a
/// Disconnect, or from the list of servers). No token: `reason` is
/// "expired" and the login opens.
#[tauri::command]
pub async fn resume_server(
    app: tauri::AppHandle,
    manager: State<'_, ConnectionManager>,
    host: State<'_, crate::host::HostManager>,
    ws: State<'_, std::sync::Arc<crate::wsclient::WsManager>>,
    addr: String,
) -> CmdResult<ResumeResult> {
    let addr = normalize_addr(&addr)?;
    let Some(saved) = manager.find(&addr) else {
        return Err(CmdError::new("not_trusted", "that server isn't saved"));
    };
    if saved.session_token.is_none() {
        return Ok(ResumeResult::failed("expired", addr));
    }
    let patience = patience_for(&host, &addr);
    let result = resume_impl(&manager, saved, patience).await;
    if result.session.is_some() {
        ws.disconnect();
        start_ws_for_active(app, &manager, &ws);
    }
    Ok(result)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before epoch")
        .as_millis() as i64
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
    let client = proven_client_for(&manager, &addr).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn where_to_look_for_a_server() {
        assert_eq!(
            addr_candidates("example.com:8443").unwrap(),
            vec!["example.com:8443"]
        );
        assert_eq!(
            addr_candidates("https://chat.example.com").unwrap(),
            vec!["chat.example.com:443"]
        );
        assert_eq!(
            addr_candidates("https://chat.example.com/").unwrap(),
            vec!["chat.example.com:443"]
        );
        assert_eq!(
            addr_candidates(" chat.example.com ").unwrap(),
            vec!["chat.example.com:7311", "chat.example.com:443"]
        );
        assert_eq!(addr_candidates("[::1]:7311").unwrap(), vec!["[::1]:7311"]);
        assert_eq!(
            addr_candidates("[::1]").unwrap(),
            vec!["[::1]:7311", "[::1]:443"]
        );
        assert!(addr_candidates("   ").is_err());
        assert_eq!(normalize_addr("http://10.0.0.2").unwrap(), "10.0.0.2:7311");
    }
}
