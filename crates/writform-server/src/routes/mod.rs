mod admin;
mod attachments;
mod auth;
mod canvas;
mod channels;
mod emotes;
mod friends;
mod groups;
mod healthz;
mod identity;
pub mod link_preview;
mod messages;
mod notes;
mod plugin_data;
pub mod sessions;
pub mod voice;

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, patch, post, put};
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use sqlx::SqlitePool;
use tower_http::trace::TraceLayer;

use crate::auth::LoginRateLimiter;
use crate::ws::WsHub;

/// Valid PBKDF2 hash of a fixed dummy password; verified against on unknown
/// usernames so login timing doesn't reveal whether an account exists. (A
/// caller "guessing" the dummy password is still rejected by the id==0 check.)
pub fn dummy_password_hash() -> &'static str {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DUMMY.get_or_init(|| writform_crypto::password::hash_password("writform-timing-dummy"))
}

#[derive(Clone)]
pub struct AppState {
    pub server_name: Arc<str>,
    pub pool: SqlitePool,
    pub identity_pubkey_b64: Arc<str>,
    pub cert_binding_sig_b64: Arc<str>,
    pub login_limiter: Arc<LoginRateLimiter>,
    pub ws: Arc<WsHub>,
    pub voice: Arc<voice::VoiceRegistry>,
    pub previews: Arc<link_preview::PreviewCache>,
    pub attachments_dir: Arc<PathBuf>,
}

impl AppState {
    pub fn new(
        server_name: String,
        pool: SqlitePool,
        identity_pubkey: &[u8],
        cert_binding_sig: &[u8],
    ) -> Self {
        Self::with_data_dir(
            server_name,
            pool,
            identity_pubkey,
            cert_binding_sig,
            std::env::temp_dir(),
        )
    }

    pub fn with_data_dir(
        server_name: String,
        pool: SqlitePool,
        identity_pubkey: &[u8],
        cert_binding_sig: &[u8],
        data_dir: PathBuf,
    ) -> Self {
        Self {
            server_name: server_name.into(),
            pool,
            identity_pubkey_b64: B64URL.encode(identity_pubkey).into(),
            cert_binding_sig_b64: B64URL.encode(cert_binding_sig).into(),
            login_limiter: Arc::new(LoginRateLimiter::default()),
            ws: Arc::new(WsHub::default()),
            voice: Arc::new(voice::VoiceRegistry::default()),
            previews: Arc::new(link_preview::PreviewCache::default()),
            attachments_dir: Arc::new(data_dir.join("attachments")),
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/healthz", get(healthz::healthz))
        .route("/api/v1/identity", get(identity::identity))
        .route("/api/v1/auth/register", post(auth::register))
        .route("/api/v1/auth/login", post(auth::login))
        .route("/api/v1/auth/logout", post(auth::logout))
        .route("/api/v1/auth/me", get(auth::me).patch(auth::update_profile))
        .route("/api/v1/auth/devices", get(auth::list_devices))
        .route("/api/v1/auth/devices/{id}", delete(auth::revoke_device))
        .route("/api/v1/admin/stats", get(admin::stats))
        .route("/api/v1/admin/users", get(admin::list_users))
        .route("/api/v1/admin/users/{id}/logout", post(admin::force_logout))
        .route("/api/v1/ws", get(crate::ws::ws_handler))
        .route(
            "/api/v1/groups",
            post(groups::create_group).get(groups::my_groups),
        )
        .route("/api/v1/groups/{id}", patch(groups::update_group))
        .route("/api/v1/groups/{id}/members", get(groups::members))
        .route("/api/v1/groups/{id}/presence", get(groups::presence))
        .route("/api/v1/groups/{id}/invites", post(groups::create_invite))
        .route("/api/v1/groups/{id}/leave", post(groups::leave_group))
        .route(
            "/api/v1/groups/{group_id}/members/{user_id}",
            delete(groups::kick_member),
        )
        .route(
            "/api/v1/groups/{group_id}/members/{user_id}/role",
            put(groups::set_role),
        )
        .route("/api/v1/invites/redeem", post(groups::redeem_invite))
        .route(
            "/api/v1/groups/{id}/channels",
            get(channels::list_channels).post(channels::create_channel),
        )
        .route("/api/v1/channels/{id}", delete(channels::delete_channel))
        .route(
            "/api/v1/channels/{id}/messages",
            get(messages::list_messages).post(messages::send_message),
        )
        .route(
            "/api/v1/messages/{id}",
            patch(messages::edit_message).delete(messages::delete_message),
        )
        .route("/api/v1/friends", get(friends::list_friends))
        .route("/api/v1/friends/{user_id}", delete(friends::remove_friend))
        .route(
            "/api/v1/friends/requests",
            get(friends::list_requests).post(friends::send_request),
        )
        .route(
            "/api/v1/friends/requests/{id}/accept",
            post(friends::accept_request),
        )
        .route(
            "/api/v1/friends/requests/{id}",
            delete(friends::delete_request),
        )
        .route("/api/v1/notes/share", post(notes::share_note))
        .route(
            "/api/v1/plugins/{plugin_id}/data/{scope}/{scope_id}",
            get(plugin_data::list_keys),
        )
        .route(
            "/api/v1/plugins/{plugin_id}/data/{scope}/{scope_id}/{key}",
            get(plugin_data::get_key).put(plugin_data::put_key),
        )
        .route("/api/v1/dms", get(friends::list_dms))
        .route("/api/v1/dms/{user_id}", post(friends::open_dm))
        .route("/api/v1/sessions", post(sessions::create_session))
        .route(
            "/api/v1/channels/{id}/sessions",
            get(sessions::list_sessions),
        )
        .route(
            "/api/v1/sessions/{id}",
            get(sessions::session_detail).delete(sessions::delete_session),
        )
        .route("/api/v1/sessions/{id}/end", post(sessions::end_session))
        .route(
            "/api/v1/sessions/{id}/prompts",
            post(sessions::create_prompt),
        )
        .route("/api/v1/prompts/{id}/start", post(sessions::start_prompt))
        .route("/api/v1/prompts/{id}/stop", post(sessions::stop_prompt))
        .route(
            "/api/v1/prompts/{id}/submission",
            put(sessions::save_submission),
        )
        .route(
            "/api/v1/groups/{id}/voice",
            get(voice::list_channels).post(voice::create_channel),
        )
        .route("/api/v1/voice/{id}", delete(voice::delete_channel))
        .route("/api/v1/voice/{id}/join", post(voice::join))
        .route("/api/v1/voice/leave", post(voice::leave))
        .route("/api/v1/voice/{id}/signal", post(voice::signal))
        .route("/api/v1/link-preview", get(link_preview::link_preview))
        .route(
            "/api/v1/groups/{id}/boards",
            get(canvas::list_boards).post(canvas::create_board),
        )
        .route(
            "/api/v1/boards/{id}",
            get(canvas::board_detail).delete(canvas::delete_board),
        )
        .route("/api/v1/boards/{id}/elements", post(canvas::create_element))
        .route(
            "/api/v1/elements/{id}",
            patch(canvas::update_element).delete(canvas::delete_element),
        )
        .route("/api/v1/attachments", post(attachments::upload))
        .route("/api/v1/attachments/{id}", get(attachments::download))
        .route(
            "/api/v1/groups/{id}/emotes",
            get(emotes::list_emotes).post(emotes::create_emote),
        )
        .route(
            "/api/v1/groups/{group_id}/emotes/{emote_id}",
            delete(emotes::delete_emote),
        )
        .layer(DefaultBodyLimit::max(
            attachments::MAX_ATTACHMENT_BYTES + 1024 * 1024,
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
