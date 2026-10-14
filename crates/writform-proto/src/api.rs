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
    /// Who may make an account here. Absent from older servers (anyone).
    #[serde(default)]
    pub registration: Option<Registration>,
}

/// Who may make an account on a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Registration {
    /// Anyone who can reach it.
    Open,
    /// Only someone with an invite code from a server admin.
    Invite,
    /// No one (a server admin's own accounts only).
    Closed,
}

impl Registration {
    pub fn as_str(self) -> &'static str {
        match self {
            Registration::Open => "open",
            Registration::Invite => "invite",
            Registration::Closed => "closed",
        }
    }
    pub fn parse(v: &str) -> Option<Self> {
        match v.trim().to_ascii_lowercase().as_str() {
            "open" => Some(Registration::Open),
            "invite" | "invites" | "invite_only" => Some(Registration::Invite),
            "closed" | "off" | "none" => Some(Registration::Closed),
            _ => None,
        }
    }
}

/// `POST /api/v1/identity/proof` — prove the server holds its identity key,
/// whatever certificate the connection was made with (a proxy's).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct IdentityProofRequest {
    /// 32 random bytes, base64url.
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct IdentityProof {
    /// ML-DSA signature over `SHA-256(nonce)` in the context
    /// `"writform-identity-proof-v1"`, base64url.
    pub sig: String,
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
    /// A server invite code, where the server asks for one.
    #[serde(default)]
    #[ts(optional)]
    pub invite: Option<String>,
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

/// `GET/PUT /api/v1/admin/registration`
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RegistrationSettings {
    pub mode: Registration,
    /// Set by the server's own configuration (`WRITFORM_REGISTRATION`):
    /// not changeable from the app.
    #[serde(default)]
    pub fixed: bool,
}

/// `POST /api/v1/admin/invites`
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateServerInviteRequest {
    /// How many accounts it may make (none: no limit).
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub max_uses: Option<i64>,
    /// How long it lasts, hours (none: until revoked).
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub expires_in_hours: Option<i64>,
}

/// A server invite, as its admins see it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ServerInvite {
    #[ts(type = "number")]
    pub id: i64,
    pub code: String,
    pub created_by: String,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
    #[ts(type = "number | null")]
    pub expires_at: Option<UnixMillis>,
    #[ts(type = "number | null")]
    pub max_uses: Option<i64>,
    #[ts(type = "number")]
    pub use_count: i64,
    /// Expired, used up or revoked.
    pub spent: bool,
}

/// Uniform error body for all non-2xx API responses.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ApiError {
    /// Stable machine-readable code, e.g. "invalid_credentials", "not_a_member".
    pub code: String,
    pub message: String,
}
