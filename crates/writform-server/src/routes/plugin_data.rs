//! Generic scoped JSON storage for client-side plugins. The server stays
//! plugin-free: it only enforces scope membership and fans out updates.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use writform_proto::{ChannelId, GroupId};

use crate::auth::AuthUser;
use crate::db::now_millis;
use crate::error::AppError;
use crate::perms;
use crate::routes::AppState;

const MAX_VALUE_BYTES: usize = 64 * 1024;

fn validate_plugin_id(id: &str) -> Result<(), AppError> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(AppError::bad_request("bad_plugin_id", "invalid plugin id"));
    }
    Ok(())
}

async fn check_scope(
    state: &AppState,
    auth: &AuthUser,
    scope: &str,
    scope_id: i64,
) -> Result<(), AppError> {
    match scope {
        "user" => {
            if scope_id != auth.user_id.0 {
                return Err(AppError::new(
                    StatusCode::FORBIDDEN,
                    "not_your_scope",
                    "user scope belongs to another user",
                ));
            }
        }
        "group" => {
            perms::require_member(&state.pool, GroupId(scope_id), auth.user_id).await?;
        }
        "channel" => {
            perms::require_channel_access(&state.pool, ChannelId(scope_id), auth.user_id).await?;
        }
        _ => {
            return Err(AppError::bad_request(
                "bad_scope",
                "scope must be user|group|channel",
            ))
        }
    }
    Ok(())
}

pub async fn list_keys(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((plugin_id, scope, scope_id)): Path<(String, String, i64)>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_plugin_id(&plugin_id)?;
    check_scope(&state, &auth, &scope, scope_id).await?;
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, value_json FROM plugin_data WHERE plugin_id = ? AND scope = ? AND scope_id = ?",
    )
    .bind(&plugin_id)
    .bind(&scope)
    .bind(scope_id)
    .fetch_all(&state.pool)
    .await?;
    let map: serde_json::Map<String, serde_json::Value> = rows
        .into_iter()
        .map(|(k, v)| {
            (
                k,
                serde_json::from_str(&v).unwrap_or(serde_json::Value::Null),
            )
        })
        .collect();
    Ok(Json(serde_json::Value::Object(map)))
}

pub async fn get_key(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((plugin_id, scope, scope_id, key)): Path<(String, String, i64, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_plugin_id(&plugin_id)?;
    check_scope(&state, &auth, &scope, scope_id).await?;
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT value_json FROM plugin_data WHERE plugin_id = ? AND scope = ? AND scope_id = ? AND key = ?",
    )
    .bind(&plugin_id)
    .bind(&scope)
    .bind(scope_id)
    .bind(&key)
    .fetch_optional(&state.pool)
    .await?;
    Ok(Json(match row {
        Some((v,)) => serde_json::from_str(&v).unwrap_or(serde_json::Value::Null),
        None => serde_json::Value::Null,
    }))
}

pub async fn put_key(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((plugin_id, scope, scope_id, key)): Path<(String, String, i64, String)>,
    Json(value): Json<serde_json::Value>,
) -> Result<StatusCode, AppError> {
    validate_plugin_id(&plugin_id)?;
    if key.is_empty() || key.len() > 128 {
        return Err(AppError::bad_request("bad_key", "invalid key"));
    }
    check_scope(&state, &auth, &scope, scope_id).await?;
    let value_json = serde_json::to_string(&value).map_err(AppError::internal)?;
    if value_json.len() > MAX_VALUE_BYTES {
        return Err(AppError::bad_request("too_large", "value too large"));
    }
    sqlx::query(
        "INSERT INTO plugin_data (plugin_id, scope, scope_id, key, value_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id, scope, scope_id, key)
         DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    )
    .bind(&plugin_id)
    .bind(&scope)
    .bind(scope_id)
    .bind(&key)
    .bind(&value_json)
    .bind(now_millis())
    .execute(&state.pool)
    .await?;

    state.ws.broadcast(
        &format!("{scope}:{scope_id}"),
        "plugin_data.updated",
        serde_json::json!({ "plugin_id": plugin_id, "scope": scope, "scope_id": scope_id, "key": key, "value": value }),
    );
    Ok(StatusCode::NO_CONTENT)
}
