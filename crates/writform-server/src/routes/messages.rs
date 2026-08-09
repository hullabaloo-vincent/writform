use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use writform_proto::chat::{
    AttachmentMeta, ChannelRead, EditMessageRequest, MarkReadRequest, Message, MessageReaction,
    ReactRequest, SearchHit, SendMessageRequest,
};
use writform_proto::{AttachmentId, ChannelId, GroupId, MessageId, UserId};

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
    /// Return a window centred on this id (jumping to a search hit or pin).
    pub around: Option<i64>,
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
    let rows: Vec<MessageRow> = if let Some(around) = query.around {
        // Jump-to-message: half a window up to the anchor (inclusive), half
        // after it, so the hit lands mid-screen with context both ways.
        let half = (limit / 2).max(1);
        let mut rows: Vec<MessageRow> = sqlx::query_as(
            "SELECT m.id, m.channel_id, m.kind, m.content, m.reply_to_id, m.created_at, m.edited_at,
                    u.id, u.username, u.display_name, u.avatar_attachment_id, u.accent_color
             FROM messages m JOIN users u ON u.id = m.author_id
             WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.id <= ?
             ORDER BY m.id DESC LIMIT ?",
        )
        .bind(channel.0)
        .bind(around)
        .bind(half)
        .fetch_all(&state.pool)
        .await?;
        rows.reverse(); // chronological
        let after_rows: Vec<MessageRow> = sqlx::query_as(
            "SELECT m.id, m.channel_id, m.kind, m.content, m.reply_to_id, m.created_at, m.edited_at,
                    u.id, u.username, u.display_name, u.avatar_attachment_id, u.accent_color
             FROM messages m JOIN users u ON u.id = m.author_id
             WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.id > ?
             ORDER BY m.id ASC LIMIT ?",
        )
        .bind(channel.0)
        .bind(around)
        .bind(half)
        .fetch_all(&state.pool)
        .await?;
        rows.extend(after_rows);
        rows
    } else if let Some(after) = query.after {
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
    // A deleted message can't stay pinned. Hard deletes cascade the pin row;
    // this soft delete has to clean up (and re-tally) itself.
    let unpinned = sqlx::query("DELETE FROM channel_pins WHERE message_id = ?")
        .bind(message_id)
        .execute(&state.pool)
        .await?
        .rows_affected()
        > 0;
    state.ws.broadcast(
        &format!("channel:{channel_id}"),
        "message.deleted",
        serde_json::json!({ "message_id": message_id, "channel_id": channel_id }),
    );
    if unpinned {
        broadcast_pins(&state, ChannelId(channel_id)).await?;
    }
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

/// Channel (and its group, when it has one) a message lives in, proving it
/// exists and is readable.
async fn message_channel(
    state: &AppState,
    message_id: i64,
    user: UserId,
) -> Result<(ChannelId, Option<GroupId>), AppError> {
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
    let group = perms::require_channel_access(&state.pool, channel, user).await?;
    Ok((channel, group))
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
    let (channel, group) = message_channel(&state, message_id, auth.user_id).await?;
    let raw = req.emoji.trim();
    // `:name:` is a custom group emote, stored as the literal token; DMs have
    // no group so only unicode emoji work there.
    let emoji: String = if let Some(name) = raw
        .strip_prefix(':')
        .and_then(|s| s.strip_suffix(':'))
        .filter(|n| {
            !n.is_empty()
                && n.len() <= 32
                && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        }) {
        let no_such = || AppError::bad_request("bad_emoji", "no such emote here");
        let group = group.ok_or_else(no_such)?;
        let exists: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM emotes WHERE group_id = ? AND name = ?")
                .bind(group.0)
                .bind(name)
                .fetch_optional(&state.pool)
                .await?;
        if exists.is_none() {
            return Err(no_such());
        }
        raw.to_string()
    } else {
        validate_emoji(raw)?.to_string()
    };
    // Idempotent: reacting twice with the same emoji is a no-op, not an error.
    sqlx::query(
        "INSERT INTO message_reactions (message_id, user_id, emoji, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(message_id)
    .bind(auth.user_id.0)
    .bind(&emoji)
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
    let (channel, _) = message_channel(&state, message_id, auth.user_id).await?;
    sqlx::query("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
        .bind(message_id)
        .bind(auth.user_id.0)
        .bind(&emoji)
        .execute(&state.pool)
        .await?;
    broadcast_reactions(&state, channel, message_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

/// `PUT /api/v1/channels/{id}/read` — advance the caller's read marker.
/// Forward-only: a lagging device sending an older id changes nothing, so
/// devices can fire this blindly and still converge on the furthest point.
pub async fn mark_read(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(req): Json<MarkReadRequest>,
) -> Result<StatusCode, AppError> {
    let channel = ChannelId(channel_id);
    perms::require_channel_access(&state.pool, channel, auth.user_id).await?;
    let exists: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM messages WHERE id = ? AND channel_id = ?")
            .bind(req.message_id.0)
            .bind(channel.0)
            .fetch_optional(&state.pool)
            .await?;
    if exists.is_none() {
        return Err(AppError::bad_request(
            "bad_message",
            "message is not in this channel",
        ));
    }
    let res = sqlx::query(
        "INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET
             last_read_message_id = excluded.last_read_message_id,
             updated_at = excluded.updated_at
         WHERE excluded.last_read_message_id > channel_reads.last_read_message_id",
    )
    .bind(auth.user_id.0)
    .bind(channel.0)
    .bind(req.message_id.0)
    .bind(now_millis())
    .execute(&state.pool)
    .await?;
    // Per-user state: only the caller's other devices care.
    if res.rows_affected() > 0 {
        state.ws.broadcast(
            &format!("user:{}", auth.user_id.0),
            "read.updated",
            serde_json::json!({
                "channel_id": channel.0,
                "last_read_message_id": req.message_id.0,
            }),
        );
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/me/reads` — every read marker the caller has, with a count of
/// later messages from OTHERS (own messages never count as unread). Channels
/// with no marker are simply absent; the client falls back to local state.
pub async fn my_reads(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Vec<ChannelRead>>, AppError> {
    let rows: Vec<(i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT r.channel_id, r.last_read_message_id, r.updated_at,
                (SELECT COUNT(*) FROM messages m
                  WHERE m.channel_id = r.channel_id
                    AND m.id > r.last_read_message_id
                    AND m.deleted_at IS NULL
                    AND m.author_id != ?) AS unread_count
         FROM channel_reads r WHERE r.user_id = ?",
    )
    .bind(auth.user_id.0)
    .bind(auth.user_id.0)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(
                |(channel_id, last_read, updated_at, unread_count)| ChannelRead {
                    channel_id: ChannelId(channel_id),
                    last_read_message_id: MessageId(last_read),
                    unread_count,
                    updated_at,
                },
            )
            .collect(),
    ))
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
    pub group_id: Option<i64>,
    pub limit: Option<i64>,
}

/// Quote every term so user text can never be FTS5 query syntax.
fn fts_query(q: &str) -> Option<String> {
    let terms: Vec<String> = q
        .split_whitespace()
        .map(|t| t.replace('"', ""))
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\""))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

/// `GET /api/v1/messages/search?q=&group_id=` — full-text search across every
/// channel the caller can read: their groups' channels plus their DMs.
pub async fn search_messages(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<SearchHit>>, AppError> {
    let Some(match_q) = fts_query(&query.q) else {
        return Err(AppError::bad_request(
            "empty_query",
            "nothing to search for",
        ));
    };
    let limit = query.limit.unwrap_or(40).clamp(1, 100);
    type HitRow = (
        i64,
        i64,
        Option<i64>,
        Option<String>,
        i64,
        i64,
        String,
        Option<String>,
        Option<i64>,
        Option<String>,
        String,
    );
    let rows: Vec<HitRow> = sqlx::query_as(
        "SELECT m.id, m.channel_id, c.group_id, c.name, m.created_at,
                u.id, u.username, u.display_name, u.avatar_attachment_id, u.accent_color,
                snippet(messages_fts, 0, '<<', '>>', '…', 12)
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN channels c ON c.id = m.channel_id
         JOIN users u ON u.id = m.author_id
         WHERE messages_fts MATCH ?
           AND m.deleted_at IS NULL
           AND ((c.group_id IS NOT NULL AND c.group_id IN
                    (SELECT group_id FROM group_members WHERE user_id = ?))
             OR (c.kind = 'dm' AND EXISTS
                    (SELECT 1 FROM dm_pairs p
                      WHERE p.channel_id = c.id AND (p.user_a = ? OR p.user_b = ?))))
           AND (? IS NULL OR c.group_id = ?)
         ORDER BY bm25(messages_fts)
         LIMIT ?",
    )
    .bind(&match_q)
    .bind(auth.user_id.0)
    .bind(auth.user_id.0)
    .bind(auth.user_id.0)
    .bind(query.group_id)
    .bind(query.group_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(
                |(
                    id,
                    channel_id,
                    group_id,
                    channel_name,
                    created_at,
                    author_id,
                    username,
                    display_name,
                    avatar,
                    accent,
                    snippet,
                )| SearchHit {
                    message_id: MessageId(id),
                    channel_id: ChannelId(channel_id),
                    group_id: group_id.map(GroupId),
                    channel_name,
                    author: perms::user_ref(
                        UserId(author_id),
                        username,
                        display_name,
                        avatar,
                        accent,
                    ),
                    snippet,
                    created_at,
                },
            )
            .collect(),
    ))
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

const MAX_PINS_PER_CHANNEL: i64 = 50;

/// Convergent pin tally for a channel — ids only, bodies stay REST-fetched
/// (the same shape the reaction broadcasts use).
async fn broadcast_pins(state: &AppState, channel: ChannelId) -> Result<(), AppError> {
    let rows: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT message_id, pinned_by, created_at FROM channel_pins
         WHERE channel_id = ? ORDER BY created_at DESC, message_id DESC",
    )
    .bind(channel.0)
    .fetch_all(&state.pool)
    .await?;
    let pins: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(message_id, pinned_by, created_at)| {
            serde_json::json!({
                "message_id": message_id,
                "pinned_by": pinned_by,
                "created_at": created_at,
            })
        })
        .collect();
    state.ws.broadcast(
        &format!("channel:{}", channel.0),
        "channel.pins",
        serde_json::json!({ "channel_id": channel.0, "pins": pins }),
    );
    Ok(())
}

/// Pinning mirrors deletion's permission: the author, or a group admin.
/// Returns the channel once the caller is allowed to (un)pin the message.
async fn require_pin_permission(
    state: &AppState,
    message_id: i64,
    user: UserId,
) -> Result<ChannelId, AppError> {
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
    let channel = ChannelId(channel_id);
    let group = perms::require_channel_access(&state.pool, channel, user).await?;
    let mut allowed = author_id == user.0;
    if !allowed {
        if let Some(group) = group {
            allowed = matches!(
                perms::member_role(&state.pool, group, user).await?,
                Some(writform_proto::chat::GroupRole::Admin)
            );
        }
    }
    if !allowed {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "not_allowed",
            "cannot pin this message",
        ));
    }
    Ok(channel)
}

pub async fn pin_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(message_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let channel = require_pin_permission(&state, message_id, auth.user_id).await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM channel_pins WHERE channel_id = ?")
        .bind(channel.0)
        .fetch_one(&state.pool)
        .await?;
    if count >= MAX_PINS_PER_CHANNEL {
        return Err(AppError::bad_request(
            "too_many_pins",
            "this channel already has the maximum number of pins",
        ));
    }
    // Idempotent: re-pinning is a no-op, not an error.
    sqlx::query(
        "INSERT INTO channel_pins (message_id, channel_id, pinned_by, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(message_id)
    .bind(channel.0)
    .bind(auth.user_id.0)
    .bind(now_millis())
    .execute(&state.pool)
    .await?;
    broadcast_pins(&state, channel).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn unpin_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(message_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let channel = require_pin_permission(&state, message_id, auth.user_id).await?;
    sqlx::query("DELETE FROM channel_pins WHERE message_id = ?")
        .bind(message_id)
        .execute(&state.pool)
        .await?;
    broadcast_pins(&state, channel).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/channels/{id}/pins` — pinned messages, newest pin first.
pub async fn list_pins(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Vec<Message>>, AppError> {
    let channel = ChannelId(channel_id);
    perms::require_channel_access(&state.pool, channel, auth.user_id).await?;
    let rows: Vec<MessageRow> = sqlx::query_as(
        "SELECT m.id, m.channel_id, m.kind, m.content, m.reply_to_id, m.created_at, m.edited_at,
                u.id, u.username, u.display_name, u.avatar_attachment_id, u.accent_color
         FROM channel_pins p
         JOIN messages m ON m.id = p.message_id
         JOIN users u ON u.id = m.author_id
         WHERE p.channel_id = ? AND m.deleted_at IS NULL
         ORDER BY p.created_at DESC, m.id DESC",
    )
    .bind(channel.0)
    .fetch_all(&state.pool)
    .await?;
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
