use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::Json;
use sha2::{Digest, Sha256};
use writform_proto::chat::AttachmentMeta;
use writform_proto::AttachmentId;

use crate::auth::AuthUser;
use crate::db::now_millis;
use crate::error::AppError;
use crate::routes::AppState;

pub const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;

/// Allowed upload types (images for chat/editors; more later).
fn allowed_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml"
    )
}

pub async fn upload(
    State(state): State<AppState>,
    auth: AuthUser,
    mut multipart: Multipart,
) -> Result<Json<AttachmentMeta>, AppError> {
    let field = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad_request("bad_multipart", e.to_string()))?
        .ok_or_else(|| AppError::bad_request("no_file", "no file field in upload"))?;

    let original_name = field.file_name().map(|s| s.to_string());
    let bytes = field
        .bytes()
        .await
        .map_err(|e| AppError::bad_request("read_failed", e.to_string()))?;
    if bytes.is_empty() {
        return Err(AppError::bad_request(
            "empty_file",
            "uploaded file is empty",
        ));
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(AppError::bad_request(
            "too_large",
            "attachment exceeds 10 MB",
        ));
    }

    // Sniff the type from content, never trust the client's claim.
    let mime = infer::get(&bytes)
        .map(|k| k.mime_type().to_string())
        .or_else(|| {
            std::str::from_utf8(&bytes)
                .ok()
                .filter(|s| s.trim_start().starts_with("<svg"))
                .map(|_| "image/svg+xml".to_string())
        })
        .unwrap_or_else(|| "application/octet-stream".to_string());
    if !allowed_mime(&mime) {
        return Err(AppError::bad_request(
            "unsupported_type",
            format!("unsupported file type {mime}"),
        ));
    }

    let sha256 = hex::encode(Sha256::digest(&bytes));
    let dir = state.attachments_dir.join(&sha256[..2]);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(AppError::internal)?;
    let path = dir.join(&sha256);
    if !path.exists() {
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(AppError::internal)?;
    }

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO attachments (uploader_id, sha256, mime, byte_size, original_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(auth.user_id.0)
    .bind(&sha256)
    .bind(&mime)
    .bind(bytes.len() as i64)
    .bind(&original_name)
    .bind(now_millis())
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(AttachmentMeta {
        id: AttachmentId(id),
        mime,
        byte_size: bytes.len() as i64,
        original_name,
    }))
}

pub async fn download(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(attachment_id): Path<i64>,
) -> Result<Response, AppError> {
    let row: Option<(String, String, i64)> =
        sqlx::query_as("SELECT sha256, mime, uploader_id FROM attachments WHERE id = ?")
            .bind(attachment_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some((sha256, mime, uploader_id)) = row else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_attachment",
            "attachment not found",
        ));
    };

    // Access: uploader always; otherwise any channel the attachment appears in
    // that the requester can read (checked against ONE containing channel —
    // emote images are additionally readable by their group's members).
    let mut allowed = uploader_id == auth.user_id.0;
    if !allowed {
        // Profile avatars are readable by every signed-in user: they appear
        // next to messages, in member lists, and on profile cards, which
        // `GET /users/{id}/profile` already exposes to any authenticated user.
        let is_avatar: Option<(i64,)> =
            sqlx::query_as("SELECT id FROM users WHERE avatar_attachment_id = ?")
                .bind(attachment_id)
                .fetch_optional(&state.pool)
                .await?;
        if is_avatar.is_some() {
            allowed = true;
        }
    }
    if !allowed {
        // Group icons: readable by that group's members (the icon shows in
        // the group rail and headers for everyone in the group).
        let groups: Vec<(i64,)> =
            sqlx::query_as("SELECT id FROM groups WHERE icon_attachment_id = ?")
                .bind(attachment_id)
                .fetch_all(&state.pool)
                .await?;
        for (group_id,) in groups {
            if crate::perms::member_role(
                &state.pool,
                writform_proto::GroupId(group_id),
                auth.user_id,
            )
            .await?
            .is_some()
            {
                allowed = true;
                break;
            }
        }
    }
    if !allowed {
        let channels: Vec<(i64,)> = sqlx::query_as(
            "SELECT DISTINCT m.channel_id FROM message_attachments ma
             JOIN messages m ON m.id = ma.message_id WHERE ma.attachment_id = ?",
        )
        .bind(attachment_id)
        .fetch_all(&state.pool)
        .await?;
        for (channel_id,) in channels {
            if crate::perms::require_channel_access(
                &state.pool,
                writform_proto::ChannelId(channel_id),
                auth.user_id,
            )
            .await
            .is_ok()
            {
                allowed = true;
                break;
            }
        }
    }
    if !allowed {
        let groups: Vec<(i64,)> =
            sqlx::query_as("SELECT group_id FROM emotes WHERE attachment_id = ?")
                .bind(attachment_id)
                .fetch_all(&state.pool)
                .await?;
        for (group_id,) in groups {
            if crate::perms::member_role(
                &state.pool,
                writform_proto::GroupId(group_id),
                auth.user_id,
            )
            .await?
            .is_some()
            {
                allowed = true;
                break;
            }
        }
    }
    if !allowed {
        // Canvas board images store the attachment id in the element's text;
        // any member of the board's group may view them.
        let groups: Vec<(i64,)> = sqlx::query_as(
            "SELECT DISTINCT b.group_id FROM canvas_elements e
             JOIN canvas_boards b ON b.id = e.board_id
             WHERE e.kind = 'image' AND e.text = CAST(? AS TEXT)",
        )
        .bind(attachment_id)
        .fetch_all(&state.pool)
        .await?;
        for (group_id,) in groups {
            if crate::perms::member_role(
                &state.pool,
                writform_proto::GroupId(group_id),
                auth.user_id,
            )
            .await?
            .is_some()
            {
                allowed = true;
                break;
            }
        }
    }
    if !allowed {
        // Images embedded in session prompt/submission docs (TipTap JSON holds
        // `writform-att://attachment/{id}"`): readable by anyone who can read
        // the session's channel. The trailing quote keeps id 5 from matching 55.
        let pattern = format!("%writform-att://attachment/{attachment_id}\"%");
        let channels: Vec<(i64,)> = sqlx::query_as(
            "SELECT s.channel_id FROM session_prompts p
             JOIN writing_sessions s ON s.id = p.session_id
             WHERE p.prompt_doc LIKE ?
             UNION
             SELECT s.channel_id FROM session_submissions sub
             JOIN session_prompts p ON p.id = sub.prompt_id
             JOIN writing_sessions s ON s.id = p.session_id
             WHERE sub.doc LIKE ?",
        )
        .bind(&pattern)
        .bind(&pattern)
        .fetch_all(&state.pool)
        .await?;
        for (channel_id,) in channels {
            if crate::perms::require_channel_access(
                &state.pool,
                writform_proto::ChannelId(channel_id),
                auth.user_id,
            )
            .await
            .is_ok()
            {
                allowed = true;
                break;
            }
        }
    }
    if !allowed {
        // Images embedded in a document's latest snapshot: readable by
        // anyone the document is shared with.
        let pattern = format!("%writform-att://attachment/{attachment_id}\"%");
        let docs: Vec<(i64,)> =
            sqlx::query_as("SELECT id FROM documents WHERE content_json LIKE ?")
                .bind(&pattern)
                .fetch_all(&state.pool)
                .await?;
        for (doc_id,) in docs {
            if crate::routes::documents::can_read(&state, doc_id, auth.user_id).await? {
                allowed = true;
                break;
            }
        }
    }
    if !allowed {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "not_allowed",
            "no access to this attachment",
        ));
    }

    let path = state.attachments_dir.join(&sha256[..2]).join(&sha256);
    let bytes = tokio::fs::read(&path).await.map_err(AppError::internal)?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .body(Body::from(bytes))
        .expect("valid response"))
}
