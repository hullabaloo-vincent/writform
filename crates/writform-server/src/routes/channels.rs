use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use writform_proto::chat::{Channel, ChannelKind, CreateChannelRequest, UpdateChannelRequest};
use writform_proto::{ChannelId, GroupId};

use crate::auth::AuthUser;
use crate::db::now_millis;
use crate::error::AppError;
use crate::perms;
use crate::routes::AppState;

fn kind_from_str(kind: &str) -> ChannelKind {
    match kind {
        "session" => ChannelKind::Session,
        "dm" => ChannelKind::Dm,
        _ => ChannelKind::Text,
    }
}

pub async fn list_channels(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(group_id): Path<i64>,
) -> Result<Json<Vec<Channel>>, AppError> {
    let group = GroupId(group_id);
    perms::require_member(&state.pool, group, auth.user_id).await?;
    let rows: Vec<(i64, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT id, kind, name, position FROM channels WHERE group_id = ? ORDER BY position, id",
    )
    .bind(group.0)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, kind, name, position)| Channel {
                id: ChannelId(id),
                group_id: Some(group),
                kind: kind_from_str(&kind),
                name,
                position,
            })
            .collect(),
    ))
}

pub async fn create_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(group_id): Path<i64>,
    Json(req): Json<CreateChannelRequest>,
) -> Result<Json<Channel>, AppError> {
    let group = GroupId(group_id);
    perms::require_admin(&state.pool, group, auth.user_id).await?;
    let name = req.name.trim().to_lowercase().replace(' ', "-");
    if name.is_empty() || name.len() > 48 {
        return Err(AppError::bad_request(
            "invalid_name",
            "channel name must be 1-48 characters",
        ));
    }
    let position: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM channels WHERE group_id = ?",
    )
    .bind(group.0)
    .fetch_one(&state.pool)
    .await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO channels (group_id, kind, name, position, created_at)
         VALUES (?, 'text', ?, ?, ?) RETURNING id",
    )
    .bind(group.0)
    .bind(&name)
    .bind(position)
    .bind(now_millis())
    .fetch_one(&state.pool)
    .await?;

    let channel = Channel {
        id: ChannelId(id),
        group_id: Some(group),
        kind: ChannelKind::Text,
        name: Some(name),
        position,
    };
    state.ws.broadcast(
        &format!("group:{group_id}"),
        "channel.created",
        serde_json::to_value(&channel).expect("serializable"),
    );
    Ok(Json(channel))
}

/// Rename a text channel (admin). Same normalization as create, so renamed
/// channels keep the `#lower-kebab` convention.
pub async fn update_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(req): Json<UpdateChannelRequest>,
) -> Result<Json<Channel>, AppError> {
    let channel = ChannelId(channel_id);
    let Some(group) = perms::require_channel_access(&state.pool, channel, auth.user_id).await?
    else {
        return Err(AppError::bad_request(
            "not_renamable",
            "DM conversations cannot be renamed",
        ));
    };
    perms::require_admin(&state.pool, group, auth.user_id).await?;
    let (kind, position): (String, i64) =
        sqlx::query_as("SELECT kind, position FROM channels WHERE id = ?")
            .bind(channel.0)
            .fetch_one(&state.pool)
            .await?;
    if kind != "text" {
        return Err(AppError::bad_request(
            "not_renamable",
            "session channels are named by their session",
        ));
    }
    let name = req.name.trim().to_lowercase().replace(' ', "-");
    if name.is_empty() || name.len() > 48 {
        return Err(AppError::bad_request(
            "invalid_name",
            "channel name must be 1-48 characters",
        ));
    }
    sqlx::query("UPDATE channels SET name = ? WHERE id = ?")
        .bind(&name)
        .bind(channel.0)
        .execute(&state.pool)
        .await?;
    let updated = Channel {
        id: channel,
        group_id: Some(group),
        kind: ChannelKind::Text,
        name: Some(name),
        position,
    };
    state.ws.broadcast(
        &format!("group:{}", group.0),
        "channel.updated",
        serde_json::to_value(&updated).expect("serializable"),
    );
    Ok(Json(updated))
}

pub async fn delete_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let channel = ChannelId(channel_id);
    let Some(group) = perms::require_channel_access(&state.pool, channel, auth.user_id).await?
    else {
        return Err(AppError::bad_request(
            "not_deletable",
            "DM conversations cannot be deleted",
        ));
    };
    perms::require_admin(&state.pool, group, auth.user_id).await?;
    let (kind,): (String,) = sqlx::query_as("SELECT kind FROM channels WHERE id = ?")
        .bind(channel.0)
        .fetch_one(&state.pool)
        .await?;
    if kind != "text" {
        return Err(AppError::bad_request(
            "not_deletable",
            "session channels are managed from the session",
        ));
    }
    sqlx::query("DELETE FROM channels WHERE id = ?")
        .bind(channel.0)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &format!("group:{}", group.0),
        "channel.deleted",
        serde_json::json!({ "channel_id": channel, "group_id": group }),
    );
    Ok(StatusCode::NO_CONTENT)
}
