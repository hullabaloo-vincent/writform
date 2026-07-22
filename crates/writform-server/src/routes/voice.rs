//! Voice rooms: definitions in SQLite, presence in memory, WebRTC signaling
//! relayed over the WS hub. Media never touches the server (P2P mesh).

use std::collections::HashMap;
use std::sync::Mutex;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use writform_proto::chat::UserRef;
use writform_proto::voice::{
    CreateVoiceChannelRequest, VoiceChannel, VoiceChannelInfo, VoiceJoinResponse,
    VoiceSignalRequest,
};
use writform_proto::{GroupId, UserId};

use crate::auth::AuthUser;
use crate::db::now_millis;
use crate::error::AppError;
use crate::perms;
use crate::routes::AppState;

/// Who is in which voice room. A user occupies at most one room at a time;
/// membership is dropped when their last socket disconnects.
#[derive(Default)]
pub struct VoiceRegistry {
    /// user id → voice channel id
    by_user: Mutex<HashMap<i64, i64>>,
}

impl VoiceRegistry {
    pub(crate) fn occupants(&self, channel_id: i64) -> Vec<i64> {
        self.by_user
            .lock()
            .expect("poisoned")
            .iter()
            .filter(|(_, c)| **c == channel_id)
            .map(|(u, _)| *u)
            .collect()
    }

    fn channel_of(&self, user: i64) -> Option<i64> {
        self.by_user.lock().expect("poisoned").get(&user).copied()
    }

    pub(crate) fn set(&self, user: i64, channel: Option<i64>) -> Option<i64> {
        let mut map = self.by_user.lock().expect("poisoned");
        match channel {
            Some(c) => map.insert(user, c),
            None => map.remove(&user),
        }
    }
}

/// The group a voice channel belongs to (also proves it exists).
async fn channel_group(state: &AppState, channel_id: i64) -> Result<GroupId, AppError> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT group_id FROM voice_channels WHERE id = ?")
        .bind(channel_id)
        .fetch_optional(&state.pool)
        .await?;
    row.map(|(g,)| GroupId(g)).ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_voice_channel",
            "voice channel not found",
        )
    })
}

async fn user_refs(state: &AppState, ids: &[i64]) -> Result<Vec<UserRef>, AppError> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        type Row = (i64, String, Option<String>, Option<i64>, Option<String>);
        let row: Option<Row> = sqlx::query_as(
            "SELECT id, username, display_name, avatar_attachment_id, accent_color
             FROM users WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
        if let Some((id, username, display_name, avatar, accent)) = row {
            out.push(perms::user_ref(
                UserId(id),
                username,
                display_name,
                avatar,
                accent,
            ));
        }
    }
    Ok(out)
}

async fn user_ref(state: &AppState, id: UserId) -> Result<UserRef, AppError> {
    let (username, display_name, avatar, accent): (
        String,
        Option<String>,
        Option<i64>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT username, display_name, avatar_attachment_id, accent_color
         FROM users WHERE id = ?",
    )
    .bind(id.0)
    .fetch_one(&state.pool)
    .await?;
    Ok(perms::user_ref(id, username, display_name, avatar, accent))
}

pub async fn list_channels(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(group_id): Path<i64>,
) -> Result<Json<Vec<VoiceChannelInfo>>, AppError> {
    perms::require_member(&state.pool, GroupId(group_id), auth.user_id).await?;
    let rows: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT id, name, created_at FROM voice_channels WHERE group_id = ? ORDER BY id",
    )
    .bind(group_id)
    .fetch_all(&state.pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, name, created_at) in rows {
        let participants = user_refs(&state, &state.voice.occupants(id)).await?;
        out.push(VoiceChannelInfo {
            channel: VoiceChannel {
                id,
                group_id: GroupId(group_id),
                name,
                created_at,
            },
            participants,
        });
    }
    Ok(Json(out))
}

pub async fn create_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(group_id): Path<i64>,
    Json(req): Json<CreateVoiceChannelRequest>,
) -> Result<Json<VoiceChannel>, AppError> {
    let group = GroupId(group_id);
    perms::require_admin(&state.pool, group, auth.user_id).await?;
    let name = req.name.trim();
    if name.is_empty() || name.len() > 60 {
        return Err(AppError::bad_request(
            "invalid_name",
            "voice channel names are 1-60 characters",
        ));
    }
    let now = now_millis();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO voice_channels (group_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(group_id)
    .bind(name)
    .bind(now)
    .fetch_one(&state.pool)
    .await?;
    let channel = VoiceChannel {
        id,
        group_id: group,
        name: name.to_string(),
        created_at: now,
    };
    state.ws.broadcast(
        &format!("group:{group_id}"),
        "voice.channel.created",
        serde_json::to_value(&channel).expect("serializable"),
    );
    Ok(Json(channel))
}

pub async fn delete_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let group = channel_group(&state, channel_id).await?;
    perms::require_admin(&state.pool, group, auth.user_id).await?;
    // Kick everyone still in the room.
    for user in state.voice.occupants(channel_id) {
        state.voice.set(user, None);
    }
    sqlx::query("DELETE FROM voice_channels WHERE id = ?")
        .bind(channel_id)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &format!("group:{}", group.0),
        "voice.channel.deleted",
        serde_json::json!({ "group_id": group, "channel_id": channel_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn join(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<VoiceJoinResponse>, AppError> {
    let group = channel_group(&state, channel_id).await?;
    perms::require_member(&state.pool, group, auth.user_id).await?;

    // Switching rooms leaves the previous one first.
    leave_current(&state, auth.user_id).await?;

    let others = state.voice.occupants(channel_id);
    state.voice.set(auth.user_id.0, Some(channel_id));
    let me = user_ref(&state, auth.user_id).await?;
    state.ws.broadcast(
        &format!("group:{}", group.0),
        "voice.joined",
        serde_json::json!({ "channel_id": channel_id, "user": me }),
    );
    Ok(Json(VoiceJoinResponse {
        participants: user_refs(&state, &others).await?,
    }))
}

pub async fn leave(State(state): State<AppState>, auth: AuthUser) -> Result<StatusCode, AppError> {
    leave_current(&state, auth.user_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Shared leave path (explicit leave, room switch, socket disconnect).
pub async fn leave_current(state: &AppState, user: UserId) -> Result<(), AppError> {
    let Some(channel_id) = state.voice.set(user.0, None) else {
        return Ok(());
    };
    if let Ok(group) = channel_group(state, channel_id).await {
        state.ws.broadcast(
            &format!("group:{}", group.0),
            "voice.left",
            serde_json::json!({ "channel_id": channel_id, "user_id": user }),
        );
    }
    Ok(())
}

pub async fn signal(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(req): Json<VoiceSignalRequest>,
) -> Result<StatusCode, AppError> {
    // Both ends must be in this room right now.
    if state.voice.channel_of(auth.user_id.0) != Some(channel_id)
        || state.voice.channel_of(req.to.0) != Some(channel_id)
    {
        return Err(AppError::bad_request(
            "not_in_room",
            "both users must be in this voice channel",
        ));
    }
    state.ws.broadcast(
        &format!("user:{}", req.to.0),
        "voice.signal",
        serde_json::json!({
            "channel_id": channel_id,
            "from": auth.user_id,
            "data": req.data,
        }),
    );
    Ok(StatusCode::NO_CONTENT)
}
