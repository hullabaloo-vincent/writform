//! Server-admin endpoints. Guarded by `users.is_server_admin` (the first
//! account registered on a fresh server).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use writform_proto::api::{AdminStats, AdminUser, User};
use writform_proto::UserId;

use crate::auth::AuthUser;
use crate::error::AppError;
use crate::routes::AppState;

async fn require_server_admin(state: &AppState, auth: &AuthUser) -> Result<(), AppError> {
    let is_admin: bool = sqlx::query_scalar("SELECT is_server_admin FROM users WHERE id = ?")
        .bind(auth.user_id.0)
        .fetch_one(&state.pool)
        .await?;
    if is_admin {
        Ok(())
    } else {
        Err(AppError::new(
            StatusCode::FORBIDDEN,
            "not_server_admin",
            "server admin required",
        ))
    }
}

pub async fn stats(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<AdminStats>, AppError> {
    require_server_admin(&state, &auth).await?;
    let count = |sql: &'static str| {
        let pool = state.pool.clone();
        async move { sqlx::query_scalar::<_, i64>(sql).fetch_one(&pool).await }
    };
    let users = count("SELECT COUNT(*) FROM users").await?;
    let groups = count("SELECT COUNT(*) FROM groups").await?;
    let messages = count("SELECT COUNT(*) FROM messages").await?;
    let sessions = count("SELECT COUNT(*) FROM writing_sessions").await?;
    let attachments_bytes = count("SELECT COALESCE(SUM(byte_size), 0) FROM attachments").await?;

    let all_users: Vec<(i64,)> = sqlx::query_as("SELECT id FROM users")
        .fetch_all(&state.pool)
        .await?;
    let ids: Vec<UserId> = all_users.into_iter().map(|(id,)| UserId(id)).collect();
    let online_users = state.ws.online_among(&ids).len() as i64;

    Ok(Json(AdminStats {
        users,
        groups,
        messages,
        sessions,
        attachments_bytes,
        online_users,
    }))
}

pub async fn list_users(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Vec<AdminUser>>, AppError> {
    require_server_admin(&state, &auth).await?;
    type Row = (
        i64,
        String,
        Option<String>,
        bool,
        i64,
        i64,
        Option<i64>,
        Option<i64>,
        Option<String>,
        String,
        Option<String>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT u.id, u.username, u.display_name, u.is_server_admin, u.created_at,
                (SELECT COUNT(*) FROM auth_sessions s WHERE s.user_id = u.id),
                u.avatar_attachment_id, u.banner_attachment_id, u.accent_color, u.status, u.bio
         FROM users u ORDER BY u.created_at",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(
                |(
                    id,
                    username,
                    display_name,
                    is_server_admin,
                    created_at,
                    device_count,
                    avatar,
                    banner,
                    accent,
                    status,
                    bio,
                )| {
                    AdminUser {
                        online: state.ws.is_online(UserId(id)),
                        user: User {
                            id: UserId(id),
                            username,
                            display_name,
                            is_server_admin,
                            avatar_attachment_id: avatar.map(writform_proto::AttachmentId),
                            banner_attachment_id: banner.map(writform_proto::AttachmentId),
                            accent_color: accent,
                            status,
                            bio,
                            created_at,
                        },
                        device_count,
                    }
                },
            )
            .collect(),
    ))
}

/// Revoke every session a user has (force logout everywhere). The admin's own
/// account is allowed too — a deliberate "log me out everywhere".
pub async fn force_logout(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(user_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    require_server_admin(&state, &auth).await?;
    sqlx::query("DELETE FROM auth_sessions WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Generate a one-time password reset code for a user. The code is shown to
/// the admin exactly once (only its hash is stored), lasts an hour, replaces
/// any earlier code, and is consumed by `POST /auth/reset-password`.
pub async fn create_reset_code(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(user_id): Path<i64>,
) -> Result<Json<writform_proto::api::ResetCodeResponse>, AppError> {
    require_server_admin(&state, &auth).await?;
    let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    if exists.is_none() {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_user",
            "user not found",
        ));
    }

    // Unambiguous alphabet (no 0/O/1/I); shown grouped for easy dictation.
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let raw: String = {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        (0..10)
            .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
            .collect()
    };
    let code = format!("{}-{}", &raw[..5], &raw[5..]);
    let code_hash = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(raw.as_bytes()))
    };
    let now = crate::db::now_millis();
    let expires_at = now + 60 * 60 * 1000;
    sqlx::query(
        "INSERT INTO password_resets (user_id, code_hash, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
            code_hash = excluded.code_hash, expires_at = excluded.expires_at,
            created_by = excluded.created_by, created_at = excluded.created_at",
    )
    .bind(user_id)
    .bind(&code_hash)
    .bind(expires_at)
    .bind(auth.user_id.0)
    .bind(now)
    .execute(&state.pool)
    .await?;
    Ok(Json(writform_proto::api::ResetCodeResponse {
        code,
        expires_at,
    }))
}
