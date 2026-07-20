use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use writform_proto::chat::{
    AttachmentMeta, EditMessageRequest, Message, MessageReaction, ReactRequest, SendMessageRequest,
};
use writform_proto::{AttachmentId, ChannelId, MessageId, UserId};

use crate::auth::AuthUser;
use crate::db::now_millis;
use crate::error::AppError;
use crate::perms;
use crate::routes::AppState;

const MAX_CONTENT_LEN: usize = 8_000;

#[derive(Deserialize)]
pub struct ListQuery {
    /// Return messages with id < before (paging back through history).
    pub before: Option<i64>,
    /// Return messages with id > after (catch-up on reconnect).
    pub after: Option<i64>,
    pub limit: Option<i64>,
}

async fn attachments_for(
    pool: &sqlx::SqlitePool,
    message_ids: &[i64],
) -> Result<std::collections::HashMap<i64, Vec<AttachmentMeta>>, sqlx::Error> {
    let mut map: std::collections::HashMap<i64, Vec<AttachmentMeta>> = Default::default();
    if message_ids.is_empty() {
        return Ok(map);
    }
    let placeholders = vec!["?"; message_ids.len()].join(",");
    let sql = format!(
        "SELECT ma.message_id, a.id, a.mime, a.byte_size, a.original_name
         FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id
         WHERE ma.message_id IN ({placeholders})"
    );
    let mut query = sqlx::query_as::<_, (i64, i64, String, i64, Option<String>)>(&sql);
    for id in message_ids {
        query = query.bind(id);
    }
    for (message_id, id, mime, byte_size, original_name) in query.fetch_all(pool).await? {
        map.entry(message_id).or_default().push(AttachmentMeta {
            id: AttachmentId(id),
            mime,
            byte_size,
            original_name,
        });
    }
    Ok(map)
}

type MessageRow = (
    i64,
    i64,
    String,
    Option<String>,
    Option<i64>,
    i64,
    Option<i64>,
    i64,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
);

fn row_to_message(
    row: MessageRow,
    attachments: Vec<AttachmentMeta>,
    reactions: Vec<MessageReaction>,
) -> Message {
    let (
        id,
        channel_id,
        kind,
        content,
        reply_to_id,
        created_at,
        edited_at,
        author_id,
        username,
        display_name,
        avatar,
        accent,
    ) = row;
    Message {
        id: MessageId(id),
        channel_id: ChannelId(channel_id),
        author: perms::user_ref(UserId(author_id), username, display_name, avatar, accent),
        kind,
        content,
        reply_to_id: reply_to_id.map(MessageId),
        attachments,
        reactions,
        created_at,
        edited_at,
    }
}

/// Reactions for a batch of messages, grouped by emoji.
///
/// Deliberately batched like `attachments_for`: rendering a channel would
/// otherwise fire one query per message. `me` is resolved here so the client
/// never has to know its own id to highlight its own reactions.
async fn reactions_for(
    pool: &sqlx::SqlitePool,
    message_ids: &[i64],
    me: UserId,
) -> Result<std::collections::HashMap<i64, Vec<MessageReaction>>, sqlx::Error> {
    let mut map: std::collections::HashMap<i64, Vec<MessageReaction>> = Default::default();
    if message_ids.is_empty() {
        return Ok(map);
    }
    let placeholders = vec!["?"; message_ids.len()].join(",");
    let sql = format!(
        "SELECT r.message_id, r.emoji, r.user_id, COALESCE(u.display_name, u.username)
         FROM message_reactions r JOIN users u ON u.id = r.user_id
         WHERE r.message_id IN ({placeholders})
         ORDER BY r.created_at, r.rowid"
    );
    let mut query = sqlx::query_as::<_, (i64, String, i64, String)>(&sql);
    for id in message_ids {
        query = query.bind(id);
    }
    for (message_id, emoji, user_id, name) in query.fetch_all(pool).await? {
        let entry = map.entry(message_id).or_default();
        match entry.iter_mut().find(|r| r.emoji == emoji) {
            Some(existing) => {
                existing.count += 1;
                existing.me |= user_id == me.0;
                // Cap the tooltip list; the count stays exact.
                if existing.users.len() < 12 {
                    existing.users.push(name);
                }
            }
            None => entry.push(MessageReaction {
                emoji,
                count: 1,
                me: user_id == me.0,
                users: vec![name],
            }),
        }
    }
    Ok(map)
}

pub async fn list_messages(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<Message>>, AppError> {
    let channel = ChannelId(channel_id);
    perms::require_channel_access(&state.pool, channel, auth.user_id).await?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);

    // Soft-deleted messages are dropped from lists entirely (MVP behavior).
    let rows: Vec<MessageRow> = if let Some(after) = query.after {
        sqlx::query_as(
            "SELECT m.id, m.channel_id, m.kind, m.content, m.reply_to_id, m.created_at, m.edited_at,
                    u.id, u.username, u.display_name, u.avatar_attachment_id, u.accent_color
             FROM messages m JOIN users u ON u.id = m.author_id
             WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.id > ?
             ORDER BY m.id ASC LIMIT ?",
        )
        .bind(channel.0)
        .bind(after)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?
    } else {
        let before = query.before.unwrap_or(i64::MAX);
        let mut rows: Vec<MessageRow> = sqlx::query_as(
            "SELECT m.id, m.channel_id, m.kind, m.content, m.reply_to_id, m.created_at, m.edited_at,
                    u.id, u.username, u.display_name, u.avatar_attachment_id, u.accent_color
             FROM messages m JOIN users u ON u.id = m.author_id
             WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.id < ?
             ORDER BY m.id DESC LIMIT ?",
        )
        .bind(channel.0)
        .bind(before)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?;
        rows.reverse(); // chronological
        rows
    };

    let ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
    let mut attachment_map = attachments_for(&state.pool, &ids).await?;
    let mut reaction_map = reactions_for(&state.pool, &ids, auth.user_id).await?;
    Ok(Json(
        rows.into_iter()
            .map(|row| {
                let atts = attachment_map.remove(&row.0).unwrap_or_default();
                let reacts = reaction_map.remove(&row.0).unwrap_or_default();
                row_to_message(row, atts, reacts)
            })
            .collect(),
    ))
}

pub async fn send_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(req): Json<SendMessageRequest>,
) -> Result<Json<Message>, AppError> {
    let channel = ChannelId(channel_id);
    perms::require_channel_access(&state.pool, channel, auth.user_id).await?;

    let content = req.content.trim();
    if content.is_empty() && req.attachment_ids.is_empty() {
        return Err(AppError::bad_request(
            "empty_message",
            "message has no content",
        ));
    }
    if content.len() > MAX_CONTENT_LEN {
        return Err(AppError::bad_request("too_long", "message is too long"));
    }

    let now = now_millis();
    let mut tx = state.pool.begin().await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO messages (channel_id, author_id, kind, content, reply_to_id, created_at)
         VALUES (?, ?, 'text', ?, ?, ?) RETURNING id",
    )
    .bind(channel.0)
    .bind(auth.user_id.0)
    .bind(content)
    .bind(req.reply_to_id.map(|m| m.0))
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;

    for att in &req.attachment_ids {
        // Only the uploader may attach their upload.
        let owned: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM attachments WHERE id = ? AND uploader_id = ?")
                .bind(att.0)
                .bind(auth.user_id.0)
                .fetch_optional(&mut *tx)
                .await?;
        if owned.is_none() {
            return Err(AppError::bad_request(
                "bad_attachment",
                "attachment not found",
            ));
        }
        sqlx::query("INSERT INTO message_attachments (message_id, attachment_id) VALUES (?, ?)")
            .bind(id)
            .bind(att.0)
            .execute(&mut *tx)
            .await?;
    }

    let (username, display_name, avatar, accent): (
        String,
        Option<String>,
        Option<i64>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT username, display_name, avatar_attachment_id, accent_color FROM users WHERE id = ?",
    )
    .bind(auth.user_id.0)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    let attachments = attachments_for(&state.pool, &[id])
        .await?
        .remove(&id)
        .unwrap_or_default();
    let message = Message {
        id: MessageId(id),
        channel_id: channel,
        author: crate::perms::user_ref(auth.user_id, username, display_name, avatar, accent),
        kind: "text".into(),
        content: Some(content.to_string()),
        reply_to_id: req.reply_to_id,
        attachments,
        reactions: vec![], // brand new message: nobody has reacted yet
        created_at: now,
        edited_at: None,
    };
    let payload = serde_json::to_value(&message).expect("serializable");
    state.ws.broadcast(
        &format!("channel:{}", channel.0),
        "message.created",
        payload.clone(),
    );
    // DMs additionally land in both participants' user rooms so an unopened
    // conversation still notifies.
    let pair: Option<(i64, i64)> =
        sqlx::query_as("SELECT user_a, user_b FROM dm_pairs WHERE channel_id = ?")
            .bind(channel.0)
            .fetch_optional(&state.pool)
            .await?;
    if let Some((a, b)) = pair {
        for uid in [a, b] {
            state
                .ws
                .broadcast(&format!("user:{uid}"), "message.created", payload.clone());
        }
    }
    Ok(Json(message))
}

pub async fn edit_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(message_id): Path<i64>,
    Json(req): Json<EditMessageRequest>,
) -> Result<StatusCode, AppError> {
    let content = req.content.trim();
    if content.is_empty() || content.len() > MAX_CONTENT_LEN {
        return Err(AppError::bad_request(
            "invalid_content",
            "invalid message content",
        ));
    }
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT channel_id, author_id FROM messages WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(message_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((channel_id, author_id)) = row else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_message",
            "message not found",
        ));
    };
    if author_id != auth.user_id.0 {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "not_author",
            "you can only edit your own messages",
        ));
    }
    let now = now_millis();
    sqlx::query("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?")
        .bind(content)
        .bind(now)
        .bind(message_id)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &format!("channel:{channel_id}"),
        "message.edited",
        serde_json::json!({ "message_id": message_id, "channel_id": channel_id, "content": content, "edited_at": now }),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(message_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT channel_id, author_id FROM messages WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(message_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((channel_id, author_id)) = row else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_message",
            "message not found",
        ));
    };

    // Author may delete their own message; a group admin may delete any.
    let mut allowed = author_id == auth.user_id.0;
    if !allowed {
        if let Some(group) =
            perms::require_channel_access(&state.pool, ChannelId(channel_id), auth.user_id).await?
        {
            allowed = matches!(
                perms::member_role(&state.pool, group, auth.user_id).await?,
                Some(writform_proto::chat::GroupRole::Admin)
            );
        }
    }
    if !allowed {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "not_allowed",
            "cannot delete this message",
        ));
    }

    sqlx::query("UPDATE messages SET deleted_at = ?, content = NULL WHERE id = ?")
        .bind(now_millis())
        .bind(message_id)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &format!("channel:{channel_id}"),
        "message.deleted",
        serde_json::json!({ "message_id": message_id, "channel_id": channel_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

/// Longest emoji we accept. Emoji can be surprisingly long once skin-tone and
/// ZWJ sequences are involved (families run past 25 bytes), so this is a
/// sanity bound against arbitrary text, not a strict grapheme check.
const MAX_EMOJI_BYTES: usize = 64;

fn validate_emoji(emoji: &str) -> Result<&str, AppError> {
    let emoji = emoji.trim();
    if emoji.is_empty() || emoji.len() > MAX_EMOJI_BYTES {
        return Err(AppError::bad_request("bad_emoji", "invalid reaction"));
    }
    // Reject anything with whitespace or ASCII control/text characters: this
    // is a reaction, not a comment.
    if emoji.chars().any(|c| c.is_whitespace() || c.is_ascii()) {
        return Err(AppError::bad_request(
            "bad_emoji",
            "reactions must be an emoji",
        ));
    }
    Ok(emoji)
}

/// Channel a message lives in, proving it exists and is readable.
async fn message_channel(
    state: &AppState,
    message_id: i64,
    user: UserId,
) -> Result<ChannelId, AppError> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT channel_id FROM messages WHERE id = ? AND deleted_at IS NULL")
            .bind(message_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some((channel_id,)) = row else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_message",
            "message not found",
        ));
    };
    let channel = ChannelId(channel_id);
    perms::require_channel_access(&state.pool, channel, user).await?;
    Ok(channel)
}

/// Broadcast the message's full reaction set so every client converges on the
/// same tallies rather than applying deltas it might have missed.
async fn broadcast_reactions(
    state: &AppState,
    channel: ChannelId,
    message_id: i64,
) -> Result<(), AppError> {
    let rows: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username)
         FROM message_reactions r JOIN users u ON u.id = r.user_id
         WHERE r.message_id = ? ORDER BY r.created_at, r.rowid",
    )
    .bind(message_id)
    .fetch_all(&state.pool)
    .await?;
    // `me` is per-viewer, so it is left false here; each client fills it in
    // from the user id list it already knows about.
    let mut grouped: Vec<serde_json::Value> = Vec::new();
    let mut order: Vec<String> = Vec::new();
    let mut by_emoji: std::collections::HashMap<String, (i64, Vec<i64>, Vec<String>)> =
        Default::default();
    for (emoji, user_id, name) in rows {
        let entry = by_emoji.entry(emoji.clone()).or_insert_with(|| {
            order.push(emoji.clone());
            (0, Vec::new(), Vec::new())
        });
        entry.0 += 1;
        entry.1.push(user_id);
        if entry.2.len() < 12 {
            entry.2.push(name);
        }
    }
    for emoji in order {
        let (count, user_ids, users) = by_emoji.remove(&emoji).expect("inserted above");
        grouped.push(serde_json::json!({
            "emoji": emoji, "count": count, "user_ids": user_ids, "users": users,
        }));
    }
    state.ws.broadcast(
        &format!("channel:{}", channel.0),
        "message.reactions",
        serde_json::json!({
            "channel_id": channel.0,
            "message_id": message_id,
            "reactions": grouped,
        }),
    );
    Ok(())
}

pub async fn add_reaction(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(message_id): Path<i64>,
    Json(req): Json<ReactRequest>,
) -> Result<StatusCode, AppError> {
    let channel = message_channel(&state, message_id, auth.user_id).await?;
    let emoji = validate_emoji(&req.emoji)?;
    // Idempotent: reacting twice with the same emoji is a no-op, not an error.
    sqlx::query(
        "INSERT INTO message_reactions (message_id, user_id, emoji, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(message_id)
    .bind(auth.user_id.0)
    .bind(emoji)
    .bind(now_millis())
    .execute(&state.pool)
    .await?;
    broadcast_reactions(&state, channel, message_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_reaction(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((message_id, emoji)): Path<(i64, String)>,
) -> Result<StatusCode, AppError> {
    let channel = message_channel(&state, message_id, auth.user_id).await?;
    sqlx::query("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
        .bind(message_id)
        .bind(auth.user_id.0)
        .bind(&emoji)
        .execute(&state.pool)
        .await?;
    broadcast_reactions(&state, channel, message_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
