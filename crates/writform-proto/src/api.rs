//! REST request/response types (`/api/v1/...`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AttachmentId, UnixMillis, UserId};

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

/// Redeem an admin-issued one-time reset code for a new password.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ResetPasswordRequest {
    pub username: String,
    pub code: String,
    pub new_password: String,
}

/// A freshly generated reset code — shown to the admin exactly once.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ResetCodeResponse {
    pub code: String,
    #[ts(type = "number")]
    pub expires_at: crate::UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct User {
    pub id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    #[serde(default)]
    pub is_server_admin: bool,
    #[serde(default)]
    pub avatar_attachment_id: Option<AttachmentId>,
    /// Profile-card banner image; the accent color fills in when absent.
    #[serde(default)]
    pub banner_attachment_id: Option<AttachmentId>,
    #[serde(default)]
    pub accent_color: Option<String>,
    /// "online" | "busy" | "hidden" — the user's chosen presence.
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub bio: Option<String>,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

fn default_status() -> String {
    "online".into()
}

/// `PUT /api/v1/auth/status`
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SetStatusRequest {
    pub status: String,
}

/// `GET /api/v1/users/{id}/profile` — the public profile card.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserProfile {
    pub id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_attachment_id: Option<AttachmentId>,
    /// Banner image for the card; accent color is the fallback fill.
    pub banner_attachment_id: Option<AttachmentId>,
    pub accent_color: Option<String>,
    pub bio: Option<String>,
    /// "online" | "busy" when reachable, None when offline (or hidden).
    pub status: Option<String>,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateProfileRequest {
    /// None clears the display name.
    pub display_name: Option<String>,
    /// None clears the avatar; the attachment must be the caller's upload.
    #[serde(default)]
    pub avatar_attachment_id: Option<AttachmentId>,
    /// None clears the banner; the attachment must be the caller's upload.
    #[serde(default)]
    pub banner_attachment_id: Option<AttachmentId>,
    /// `#rrggbb`, or None for the default look.
    #[serde(default)]
    pub accent_color: Option<String>,
    /// "About me" shown on the profile card (None clears, max 300 chars).
    #[serde(default)]
    pub bio: Option<String>,
}

/// A device row from `auth_sessions` (token never leaves the server).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DeviceSession {
    #[ts(type = "number")]
    pub id: i64,
    pub device_label: Option<String>,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
    #[ts(type = "number")]
    pub last_seen_at: UnixMillis,
    /// True for the session making this request.
    pub current: bool,
}

/// `GET /api/v1/link-preview?url=` — server-fetched page metadata for canvas
/// link cards. Fields are None when the page is unreachable or opaque.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LinkPreview {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image_url: Option<String>,
}

/// `GET /api/v1/admin/stats`
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AdminStats {
    #[ts(type = "number")]
    pub users: i64,
    #[ts(type = "number")]
    pub groups: i64,
    #[ts(type = "number")]
    pub messages: i64,
    #[ts(type = "number")]
    pub sessions: i64,
    #[ts(type = "number")]
    pub attachments_bytes: i64,
    #[ts(type = "number")]
    pub online_users: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AdminUser {
    pub user: User,
    #[ts(type = "number")]
    pub device_count: i64,
    pub online: bool,
}

/// Uniform error body for all non-2xx API responses.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ApiError {
    /// Stable machine-readable code, e.g. "invalid_credentials", "not_a_member".
    pub code: String,
    pub message: String,
}
