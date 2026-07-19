use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::Json;
use std::net::SocketAddr;
use writform_proto::api::{AuthResponse, LoginRequest, RegisterRequest, User};
use writform_proto::UserId;

use crate::auth::{AuthUser, SESSION_LIFETIME_MS};
use crate::db::now_millis;
use crate::error::AppError;
use crate::routes::AppState;

fn validate_username(username: &str) -> Result<(), AppError> {
    let ok_chars = username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if username.len() < 3 || username.len() > 32 || !ok_chars {
        return Err(AppError::bad_request(
            "invalid_username",
            "username must be 3-32 characters: letters, digits, '_' or '-'",
        ));
    }
    Ok(())
}

fn validate_password(password: &str) -> Result<(), AppError> {
    if password.len() < 8 || password.len() > 512 {
        return Err(AppError::bad_request(
            "invalid_password",
            "password must be at least 8 characters",
        ));
    }
    Ok(())
}

async fn create_session(
    state: &AppState,
    user_id: UserId,
    device_label: Option<String>,
) -> Result<String, AppError> {
    let token = writform_crypto::token::generate_token();
    let now = now_millis();
    sqlx::query(
        "INSERT INTO auth_sessions (user_id, token_hash, device_label, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(user_id.0)
    .bind(writform_crypto::token::token_hash(&token))
    .bind(device_label)
    .bind(now)
    .bind(now + SESSION_LIFETIME_MS)
    .bind(now)
    .execute(&state.pool)
    .await?;
    Ok(token)
}

type UserRow = (
    i64,
    String,
    Option<String>,
    bool,
    i64,
    Option<i64>,
    Option<String>,
);

const USER_SELECT: &str = "SELECT id, username, display_name, is_server_admin, created_at,
    avatar_attachment_id, accent_color FROM users WHERE id = ?";

fn user_row_to_api(row: UserRow) -> User {
    let (id, username, display_name, is_server_admin, created_at, avatar, accent) = row;
    User {
        id: UserId(id),
        username,
        display_name,
        is_server_admin,
        avatar_attachment_id: avatar.map(writform_proto::AttachmentId),
        accent_color: accent,
        created_at,
    }
}

pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    validate_username(&req.username)?;
    validate_password(&req.password)?;

    // PBKDF2 at 210k iterations is deliberately slow — keep it off the async workers.
    let password_hash = tokio::task::spawn_blocking(move || {
        writform_crypto::password::hash_password(&req.password)
    })
    .await
    .map_err(AppError::internal)?;

    let now = now_millis();
    // The first account on a fresh server is its admin.
    let is_first: bool = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
        .fetch_one(&state.pool)
        .await?
        == 0;
    let result = sqlx::query_scalar::<_, i64>(
        "INSERT INTO users (username, password_hash, is_server_admin, created_at) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(&req.username)
    .bind(&password_hash)
    .bind(is_first)
    .bind(now)
    .fetch_one(&state.pool)
    .await;

    let id = match result {
        Ok(id) => id,
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "username_taken",
                "that username is already registered",
            ));
        }
        Err(e) => return Err(e.into()),
    };

    let token = create_session(&state, UserId(id), None).await?;
    Ok(Json(AuthResponse {
        token,
        user: user_row_to_api((id, req.username, None, is_first, now, None, None)),
    }))
}

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    if !state.login_limiter.check(addr.ip(), &req.username) {
        return Err(AppError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many login attempts; try again in a minute",
        ));
    }

    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT id, password_hash FROM users WHERE username = ?")
            .bind(&req.username)
            .fetch_optional(&state.pool)
            .await?;

    // Verify against a dummy hash on unknown users so response timing doesn't
    // reveal whether the username exists.
    let (id, password_hash) = match row {
        Some(r) => r,
        None => (0, crate::routes::dummy_password_hash().to_string()),
    };

    let password = req.password;
    let valid = tokio::task::spawn_blocking(move || {
        writform_crypto::password::verify_password(&password, &password_hash).unwrap_or(false)
    })
    .await
    .map_err(AppError::internal)?;

    if !valid || id == 0 {
        return Err(AppError::unauthorized(
            "invalid_credentials",
            "unknown username or wrong password",
        ));
    }

    let token = create_session(&state, UserId(id), req.device_label).await?;
    Ok(Json(AuthResponse {
        token,
        user: {
            let row: UserRow = sqlx::query_as(USER_SELECT)
                .bind(id)
                .fetch_one(&state.pool)
                .await?;
            user_row_to_api(row)
        },
    }))
}

pub async fn logout(State(state): State<AppState>, auth: AuthUser) -> Result<StatusCode, AppError> {
    sqlx::query("DELETE FROM auth_sessions WHERE token_hash = ?")
        .bind(&auth.token_hash)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn me(State(state): State<AppState>, auth: AuthUser) -> Result<Json<User>, AppError> {
    let row: UserRow = sqlx::query_as(USER_SELECT)
        .bind(auth.user_id.0)
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(user_row_to_api(row)))
}

pub async fn update_profile(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<writform_proto::api::UpdateProfileRequest>,
) -> Result<Json<User>, AppError> {
    let display_name = req
        .display_name
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());
    if display_name.as_ref().is_some_and(|d| d.len() > 64) {
        return Err(AppError::bad_request(
            "invalid_display_name",
            "display name must be at most 64 characters",
        ));
    }
    let accent = req
        .accent_color
        .map(|c| c.trim().to_lowercase())
        .filter(|c| !c.is_empty());
    if let Some(c) = &accent {
        let valid =
            c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
        if !valid {
            return Err(AppError::bad_request(
                "invalid_color",
                "accent color must look like #rrggbb",
            ));
        }
    }
    if let Some(att) = req.avatar_attachment_id {
        // The avatar must be the caller's own upload.
        let owned: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM attachments WHERE id = ? AND uploader_id = ?")
                .bind(att.0)
                .bind(auth.user_id.0)
                .fetch_optional(&state.pool)
                .await?;
        if owned.is_none() {
            return Err(AppError::bad_request(
                "bad_attachment",
                "avatar attachment not found",
            ));
        }
    }
    sqlx::query(
        "UPDATE users SET display_name = ?, avatar_attachment_id = ?, accent_color = ? WHERE id = ?",
    )
    .bind(&display_name)
    .bind(req.avatar_attachment_id.map(|a| a.0))
    .bind(&accent)
    .bind(auth.user_id.0)
    .execute(&state.pool)
    .await?;
    me(State(state), auth).await
}

pub async fn list_devices(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Vec<writform_proto::api::DeviceSession>>, AppError> {
    let rows: Vec<(i64, Option<String>, i64, i64, String)> = sqlx::query_as(
        "SELECT id, device_label, created_at, last_seen_at, token_hash
         FROM auth_sessions WHERE user_id = ? ORDER BY last_seen_at DESC",
    )
    .bind(auth.user_id.0)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, device_label, created_at, last_seen_at, token_hash)| {
                writform_proto::api::DeviceSession {
                    id,
                    device_label,
                    created_at,
                    last_seen_at,
                    current: token_hash == auth.token_hash,
                }
            })
            .collect(),
    ))
}

/// Revoke one of YOUR device sessions (force-logout that device).
pub async fn revoke_device(
    State(state): State<AppState>,
    auth: AuthUser,
    axum::extract::Path(session_id): axum::extract::Path<i64>,
) -> Result<StatusCode, AppError> {
    sqlx::query("DELETE FROM auth_sessions WHERE id = ? AND user_id = ?")
        .bind(session_id)
        .bind(auth.user_id.0)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
