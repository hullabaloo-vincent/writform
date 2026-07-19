//! REST request/response types (`/api/v1/...`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{UnixMillis, UserId};

/// `GET /api/v1/healthz`
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Healthz {
    pub ok: bool,
    pub server_name: String,
    pub protocol_version: u32,
    #[ts(type = "number")]
    pub server_time: UnixMillis,
}

/// `GET /api/v1/identity` — unauthenticated server identity for TOFU pinning.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ServerIdentity {
    pub server_name: String,
    /// ML-DSA-65 public key, base64url.
    pub mldsa_pubkey: String,
    /// ML-DSA signature over `"writform-cert-binding-v1" || SHA-256(cert SPKI)`, base64url.
    pub cert_binding_sig: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
    /// Free-form label shown in the user's session list, e.g. "MacBook Pro".
    pub device_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AuthResponse {
    pub token: String,
    pub user: User,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct User {
    pub id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

/// Uniform error body for all non-2xx API responses.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ApiError {
    /// Stable machine-readable code, e.g. "invalid_credentials", "not_a_member".
    pub code: String,
    pub message: String,
}
