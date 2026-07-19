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
        Option<String>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT u.id, u.username, u.display_name, u.is_server_admin, u.created_at,
                (SELECT COUNT(*) FROM auth_sessions s WHERE s.user_id = u.id),
                u.avatar_attachment_id, u.accent_color
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
                    accent,
                )| {
                    AdminUser {
                        online: state.ws.is_online(UserId(id)),
                        user: User {
                            id: UserId(id),
                            username,
                            display_name,
                            is_server_admin,
                            avatar_attachment_id: avatar.map(writform_proto::AttachmentId),
                            accent_color: accent,
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
