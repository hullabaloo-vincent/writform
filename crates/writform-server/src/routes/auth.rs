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

fn user_row_to_api(
    id: i64,
    username: String,
    display_name: Option<String>,
    created_at: i64,
) -> User {
    User {
        id: UserId(id),
        username,
        display_name,
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
    let result = sqlx::query_scalar::<_, i64>(
        "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(&req.username)
    .bind(&password_hash)
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
        user: user_row_to_api(id, req.username, None, now),
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

    let row: Option<(i64, String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT id, username, password_hash, display_name, created_at FROM users WHERE username = ?",
    )
    .bind(&req.username)
    .fetch_optional(&state.pool)
    .await?;

    // Verify against a dummy hash on unknown users so response timing doesn't
    // reveal whether the username exists.
    let (id, username, password_hash, display_name, created_at) = match row {
        Some(r) => r,
        None => (
            0,
            String::new(),
            crate::routes::dummy_password_hash().to_string(),
            None,
            0,
        ),
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
        user: user_row_to_api(id, username, display_name, created_at),
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
    let (id, username, display_name, created_at): (i64, String, Option<String>, i64) =
        sqlx::query_as("SELECT id, username, display_name, created_at FROM users WHERE id = ?")
            .bind(auth.user_id.0)
            .fetch_one(&state.pool)
            .await?;
    Ok(Json(user_row_to_api(
        id,
        username,
        display_name,
        created_at,
    )))
}
