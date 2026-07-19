use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use writform_proto::chat::UserRef;
use writform_proto::UserId;

use crate::auth::AuthUser;
use crate::db::now_millis;
use crate::error::AppError;
use crate::routes::AppState;

const MAX_NOTE_BYTES: usize = 1024 * 1024;

#[derive(serde::Deserialize)]
pub struct ShareNoteRequest {
    pub friend_id: i64,
    pub title: String,
    pub content_md: String,
}

/// Share a snapshot of a note with a friend: lands as a `shared_note` message
/// in the DM conversation (created if needed).
pub async fn share_note(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<ShareNoteRequest>,
) -> Result<StatusCode, AppError> {
    let title = req.title.trim();
    if title.is_empty() || title.len() > 200 {
        return Err(AppError::bad_request("invalid_title", "invalid note title"));
    }
    if req.content_md.len() > MAX_NOTE_BYTES {
        return Err(AppError::bad_request(
            "too_large",
            "note is too large to share",
        ));
    }

    let (a, b) = if auth.user_id.0 < req.friend_id {
        (auth.user_id.0, req.friend_id)
    } else {
        (req.friend_id, auth.user_id.0)
    };
    let friends: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?")
            .bind(a)
            .bind(b)
            .fetch_optional(&state.pool)
            .await?;
    if friends.is_none() {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "not_friends",
            "you can only share notes with friends",
        ));
    }

    let now = now_millis();
    let mut tx = state.pool.begin().await?;
    let channel_id: i64 = match sqlx::query_scalar::<_, i64>(
        "SELECT channel_id FROM dm_pairs WHERE user_a = ? AND user_b = ?",
    )
    .bind(a)
    .bind(b)
    .fetch_optional(&mut *tx)
    .await?
    {
        Some(id) => id,
        None => {
            let id: i64 = sqlx::query_scalar(
                "INSERT INTO channels (group_id, kind, name, position, created_at)
                 VALUES (NULL, 'dm', NULL, 0, ?) RETURNING id",
            )
            .bind(now)
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query("INSERT INTO dm_pairs (channel_id, user_a, user_b) VALUES (?, ?, ?)")
                .bind(id)
                .bind(a)
                .bind(b)
                .execute(&mut *tx)
                .await?;
            id
        }
    };

    sqlx::query(
        "INSERT INTO shared_notes (owner_id, recipient_id, title, content_md, created_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(auth.user_id.0)
    .bind(req.friend_id)
    .bind(title)
    .bind(&req.content_md)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    let payload = serde_json::json!({ "title": title, "content_md": req.content_md }).to_string();
    let message_id: i64 = sqlx::query_scalar(
        "INSERT INTO messages (channel_id, author_id, kind, content, created_at)
         VALUES (?, ?, 'shared_note', ?, ?) RETURNING id",
    )
    .bind(channel_id)
    .bind(auth.user_id.0)
    .bind(&payload)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
    let (username, display_name): (String, Option<String>) =
        sqlx::query_as("SELECT username, display_name FROM users WHERE id = ?")
            .bind(auth.user_id.0)
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;

    let message = writform_proto::chat::Message {
        id: writform_proto::MessageId(message_id),
        channel_id: writform_proto::ChannelId(channel_id),
        author: UserRef {
            id: UserId(auth.user_id.0),
            username,
            display_name,
        },
        kind: "shared_note".into(),
        content: Some(payload),
        reply_to_id: None,
        attachments: vec![],
        created_at: now,
        edited_at: None,
    };
    let value = serde_json::to_value(&message).expect("serializable");
    state.ws.broadcast(
        &format!("channel:{channel_id}"),
        "message.created",
        value.clone(),
    );
    for uid in [a, b] {
        state
            .ws
            .broadcast(&format!("user:{uid}"), "message.created", value.clone());
    }
    Ok(StatusCode::NO_CONTENT)
}
