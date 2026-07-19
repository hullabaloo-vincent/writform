use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use writform_proto::sessions::{
    CreatePromptRequest, CreateSessionRequest, PromptState, SaveSubmissionRequest, SessionDetail,
    SessionPrompt, SessionState, Submission, WritingSession,
};
use writform_proto::{ChannelId, UserId, WritingSessionId};

use crate::auth::AuthUser;
use crate::db::now_millis;
use crate::error::AppError;
use crate::perms;
use crate::routes::AppState;

/// Cap prompt/submission docs (TipTap JSON) to keep rows and fan-out sane.
const MAX_DOC_BYTES: usize = 256 * 1024;
const MAX_DOC_DEPTH: usize = 64;
/// Autosave snapshot cadence (safety net, not a keystroke timeline).
const SNAPSHOT_INTERVAL_MS: i64 = 60_000;

fn validate_doc(doc: &serde_json::Value) -> Result<String, AppError> {
    fn depth(v: &serde_json::Value) -> usize {
        match v {
            serde_json::Value::Array(items) => 1 + items.iter().map(depth).max().unwrap_or(0),
            serde_json::Value::Object(map) => 1 + map.values().map(depth).max().unwrap_or(0),
            _ => 0,
        }
    }
    let text = serde_json::to_string(doc).map_err(AppError::internal)?;
    if text.len() > MAX_DOC_BYTES {
        return Err(AppError::bad_request(
            "doc_too_large",
            "document is too large",
        ));
    }
    if depth(doc) > MAX_DOC_DEPTH {
        return Err(AppError::bad_request(
            "doc_too_deep",
            "document nesting is too deep",
        ));
    }
    Ok(text)
}

fn state_from_str(s: &str) -> PromptState {
    match s {
        "running" => PromptState::Running,
        "ended" => PromptState::Ended,
        _ => PromptState::Draft,
    }
}

type SessionRow = (
    i64,
    i64,
    String,
    String,
    Option<i64>,
    i64,
    Option<i64>,
    i64,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
);

fn row_to_session(row: SessionRow) -> WritingSession {
    let (
        id,
        channel_id,
        title,
        state,
        chat_channel_id,
        created_at,
        ended_at,
        creator_id,
        username,
        display_name,
        avatar,
        accent,
    ) = row;
    WritingSession {
        id: WritingSessionId(id),
        channel_id: ChannelId(channel_id),
        creator: perms::user_ref(UserId(creator_id), username, display_name, avatar, accent),
        title,
        state: if state == "ended" {
            SessionState::Ended
        } else {
            SessionState::Active
        },
        chat_channel_id: ChannelId(chat_channel_id.expect("chat channel always created")),
        created_at,
        ended_at,
    }
}

const SESSION_SELECT: &str = "SELECT s.id, s.channel_id, s.title, s.state, s.chat_channel_id,
    s.created_at, s.ended_at, u.id, u.username, u.display_name,
    u.avatar_attachment_id, u.accent_color
    FROM writing_sessions s JOIN users u ON u.id = s.creator_id";

/// Session access = access to its home channel. Returns the session row.
async fn require_session_access(
    state: &AppState,
    session_id: i64,
    user: UserId,
) -> Result<WritingSession, AppError> {
    let row: Option<SessionRow> = sqlx::query_as(&format!("{SESSION_SELECT} WHERE s.id = ?"))
        .bind(session_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some(row) = row else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_session",
            "session not found",
        ));
    };
    let session = row_to_session(row);
    perms::require_channel_access(&state.pool, session.channel_id, user).await?;
    Ok(session)
}

pub async fn create_session(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<CreateSessionRequest>,
) -> Result<Json<WritingSession>, AppError> {
    let title = req.title.trim();
    if title.is_empty() || title.len() > 120 {
        return Err(AppError::bad_request(
            "invalid_title",
            "title must be 1-120 characters",
        ));
    }
    let Some(group) =
        perms::require_channel_access(&state.pool, req.channel_id, auth.user_id).await?
    else {
        return Err(AppError::bad_request(
            "bad_channel",
            "sessions live in group channels",
        ));
    };

    let now = now_millis();
    let mut tx = state.pool.begin().await?;
    let chat_channel_id: i64 = sqlx::query_scalar(
        "INSERT INTO channels (group_id, kind, name, position, created_at)
         VALUES (?, 'session', ?, 1000000, ?) RETURNING id",
    )
    .bind(group.0)
    .bind(format!("session: {title}"))
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO writing_sessions (channel_id, creator_id, title, state, chat_channel_id, created_at)
         VALUES (?, ?, ?, 'active', ?, ?) RETURNING id",
    )
    .bind(req.channel_id.0)
    .bind(auth.user_id.0)
    .bind(title)
    .bind(chat_channel_id)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
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
    // Announce the session in its home channel so members can join from chat.
    let card_content = serde_json::json!({ "session_id": id, "title": title }).to_string();
    let message_id: i64 = sqlx::query_scalar(
        "INSERT INTO messages (channel_id, author_id, kind, content, created_at)
         VALUES (?, ?, 'session', ?, ?) RETURNING id",
    )
    .bind(req.channel_id.0)
    .bind(auth.user_id.0)
    .bind(&card_content)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    state.ws.broadcast(
        &format!("channel:{}", req.channel_id.0),
        "message.created",
        serde_json::to_value(writform_proto::chat::Message {
            id: writform_proto::MessageId(message_id),
            channel_id: req.channel_id,
            author: perms::user_ref(
                auth.user_id,
                username.clone(),
                display_name.clone(),
                avatar,
                accent.clone(),
            ),
            kind: "session".into(),
            content: Some(card_content),
            reply_to_id: None,
            attachments: vec![],
            created_at: now,
            edited_at: None,
        })
        .expect("serializable"),
    );

    let session = WritingSession {
        id: WritingSessionId(id),
        channel_id: req.channel_id,
        creator: perms::user_ref(auth.user_id, username, display_name, avatar, accent),
        title: title.to_string(),
        state: SessionState::Active,
        chat_channel_id: ChannelId(chat_channel_id),
        created_at: now,
        ended_at: None,
    };
    state.ws.broadcast(
        &format!("channel:{}", req.channel_id.0),
        "session.created",
        serde_json::to_value(&session).expect("serializable"),
    );
    Ok(Json(session))
}

pub async fn list_sessions(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Vec<WritingSession>>, AppError> {
    perms::require_channel_access(&state.pool, ChannelId(channel_id), auth.user_id).await?;
    let rows: Vec<SessionRow> = sqlx::query_as(&format!(
        "{SESSION_SELECT} WHERE s.channel_id = ? ORDER BY s.id DESC"
    ))
    .bind(channel_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows.into_iter().map(row_to_session).collect()))
}

pub async fn session_detail(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(session_id): Path<i64>,
) -> Result<Json<SessionDetail>, AppError> {
    let session = require_session_access(&state, session_id, auth.user_id).await?;

    type PromptRow = (
        i64,
        i64,
        i64,
        String,
        Option<i64>,
        String,
        Option<i64>,
        Option<i64>,
        Option<i64>,
    );
    let prompt_rows: Vec<PromptRow> = sqlx::query_as(
        "SELECT id, creator_id, position, prompt_doc, timer_seconds, state, started_at, ends_at, ended_at
         FROM session_prompts WHERE session_id = ? ORDER BY position, id",
    )
    .bind(session_id)
    .fetch_all(&state.pool)
    .await?;
    let prompts: Vec<SessionPrompt> = prompt_rows
        .into_iter()
        .map(
            |(id, creator_id, position, doc, timer, st, started_at, ends_at, ended_at)| {
                SessionPrompt {
                    id,
                    session_id: session.id,
                    creator_id: UserId(creator_id),
                    position,
                    prompt_doc: serde_json::from_str(&doc).unwrap_or(serde_json::Value::Null),
                    timer_seconds: timer,
                    state: state_from_str(&st),
                    started_at,
                    ends_at,
                    ended_at,
                }
            },
        )
        .collect();

    // Own submissions always; everyone's once the prompt has ended.
    type SubRow = (
        i64,
        i64,
        String,
        i64,
        i64,
        String,
        Option<String>,
        Option<i64>,
        Option<String>,
    );
    let sub_rows: Vec<SubRow> = sqlx::query_as(
        "SELECT sub.id, sub.prompt_id, sub.doc, sub.updated_at, u.id, u.username, u.display_name,
                u.avatar_attachment_id, u.accent_color
         FROM session_submissions sub
         JOIN session_prompts p ON p.id = sub.prompt_id
         JOIN users u ON u.id = sub.user_id
         WHERE p.session_id = ? AND (sub.user_id = ? OR p.state = 'ended')
         ORDER BY sub.prompt_id, sub.id",
    )
    .bind(session_id)
    .bind(auth.user_id.0)
    .fetch_all(&state.pool)
    .await?;
    let submissions = sub_rows
        .into_iter()
        .map(
            |(id, prompt_id, doc, updated_at, uid, username, display_name, avatar, accent)| {
                Submission {
                    id,
                    prompt_id,
                    author: perms::user_ref(UserId(uid), username, display_name, avatar, accent),
                    doc: serde_json::from_str(&doc).unwrap_or(serde_json::Value::Null),
                    updated_at,
                }
            },
        )
        .collect();

    Ok(Json(SessionDetail {
        session,
        prompts,
        submissions,
    }))
}

/// Permanently delete a session: its prompts, submissions, snapshots (FK
/// cascades) and its dedicated side-chat channel (messages cascade).
pub async fn delete_session(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(session_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let session = require_session_access(&state, session_id, auth.user_id).await?;
    require_creator_or_admin(&state, &session, auth.user_id).await?;

    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM writing_sessions WHERE id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM channels WHERE id = ?")
        .bind(session.chat_channel_id.0)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let data = serde_json::json!({ "session_id": session_id });
    state.ws.broadcast(
        &format!("session:{session_id}"),
        "session.deleted",
        data.clone(),
    );
    state.ws.broadcast(
        &format!("channel:{}", session.channel_id.0),
        "session.deleted",
        data,
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn end_session(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(session_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let session = require_session_access(&state, session_id, auth.user_id).await?;
    require_creator_or_admin(&state, &session, auth.user_id).await?;

    // End any running prompts first so their writings are revealed.
    let running: Vec<(i64,)> =
        sqlx::query_as("SELECT id FROM session_prompts WHERE session_id = ? AND state = 'running'")
            .bind(session_id)
            .fetch_all(&state.pool)
            .await?;
    for (prompt_id,) in running {
        end_prompt_inner(&state, prompt_id, "session_ended").await?;
    }

    sqlx::query("UPDATE writing_sessions SET state = 'ended', ended_at = ? WHERE id = ? AND state = 'active'")
        .bind(now_millis())
        .bind(session_id)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &format!("session:{session_id}"),
        "session.ended",
        serde_json::json!({ "session_id": session_id }),
    );
    state.ws.broadcast(
        &format!("channel:{}", session.channel_id.0),
        "session.ended",
        serde_json::json!({ "session_id": session_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn require_creator_or_admin(
    state: &AppState,
    session: &WritingSession,
    user: UserId,
) -> Result<(), AppError> {
    if session.creator.id == user {
        return Ok(());
    }
    let group = perms::require_channel_access(&state.pool, session.channel_id, user).await?;
    if let Some(group) = group {
        if matches!(
            perms::member_role(&state.pool, group, user).await?,
            Some(writform_proto::chat::GroupRole::Admin)
        ) {
            return Ok(());
        }
    }
    Err(AppError::new(
        StatusCode::FORBIDDEN,
        "not_allowed",
        "only the creator or a group admin may do this",
    ))
}

pub async fn create_prompt(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(session_id): Path<i64>,
    Json(req): Json<CreatePromptRequest>,
) -> Result<Json<SessionPrompt>, AppError> {
    let session = require_session_access(&state, session_id, auth.user_id).await?;
    if matches!(session.state, SessionState::Ended) {
        return Err(AppError::bad_request(
            "session_ended",
            "this session has ended",
        ));
    }
    if let Some(timer) = req.timer_seconds {
        if !(10..=24 * 3600).contains(&timer) {
            return Err(AppError::bad_request(
                "bad_timer",
                "timer must be 10s to 24h",
            ));
        }
    }
    let doc_text = validate_doc(&req.prompt_doc)?;

    let now = now_millis();
    let position: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM session_prompts WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_one(&state.pool)
    .await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO session_prompts (session_id, creator_id, position, prompt_doc, timer_seconds, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(session_id)
    .bind(auth.user_id.0)
    .bind(position)
    .bind(&doc_text)
    .bind(req.timer_seconds)
    .bind(now)
    .fetch_one(&state.pool)
    .await?;

    let prompt = SessionPrompt {
        id,
        session_id: session.id,
        creator_id: auth.user_id,
        position,
        prompt_doc: req.prompt_doc,
        timer_seconds: req.timer_seconds,
        state: PromptState::Draft,
        started_at: None,
        ends_at: None,
        ended_at: None,
    };
    state.ws.broadcast(
        &format!("session:{session_id}"),
        "prompt.created",
        serde_json::to_value(&prompt).expect("serializable"),
    );
    Ok(Json(prompt))
}

async fn prompt_session(state: &AppState, prompt_id: i64) -> Result<(i64, String, i64), AppError> {
    let row: Option<(i64, String, i64)> =
        sqlx::query_as("SELECT session_id, state, creator_id FROM session_prompts WHERE id = ?")
            .bind(prompt_id)
            .fetch_optional(&state.pool)
            .await?;
    row.ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "no_such_prompt", "prompt not found"))
}

pub async fn start_prompt(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(prompt_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let (session_id, prompt_state, creator_id) = prompt_session(&state, prompt_id).await?;
    let session = require_session_access(&state, session_id, auth.user_id).await?;
    if creator_id != auth.user_id.0 {
        require_creator_or_admin(&state, &session, auth.user_id).await?;
    }
    if prompt_state != "draft" {
        return Err(AppError::bad_request(
            "already_started",
            "prompt already started",
        ));
    }

    let now = now_millis();
    let timer: Option<i64> =
        sqlx::query_scalar("SELECT timer_seconds FROM session_prompts WHERE id = ?")
            .bind(prompt_id)
            .fetch_one(&state.pool)
            .await?;
    let ends_at = timer.map(|t| now + t * 1000);
    sqlx::query(
        "UPDATE session_prompts SET state = 'running', started_at = ?, ends_at = ? WHERE id = ?",
    )
    .bind(now)
    .bind(ends_at)
    .bind(prompt_id)
    .execute(&state.pool)
    .await?;

    if let Some(ends_at) = ends_at {
        spawn_prompt_timer(state.clone(), prompt_id, ends_at);
    }

    state.ws.broadcast(
        &format!("session:{session_id}"),
        "prompt.started",
        serde_json::to_value(writform_proto::ws::PromptStarted {
            session_id: session.id,
            prompt_id,
            started_at: now,
            ends_at,
        })
        .expect("serializable"),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn stop_prompt(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(prompt_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let (session_id, prompt_state, creator_id) = prompt_session(&state, prompt_id).await?;
    let session = require_session_access(&state, session_id, auth.user_id).await?;
    if creator_id != auth.user_id.0 {
        require_creator_or_admin(&state, &session, auth.user_id).await?;
    }
    if prompt_state != "running" {
        return Err(AppError::bad_request(
            "not_running",
            "prompt is not running",
        ));
    }
    end_prompt_inner(&state, prompt_id, "stopped").await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Shared prompt-ending path for early stop, timer expiry, and session end.
pub async fn end_prompt_inner(
    state: &AppState,
    prompt_id: i64,
    reason: &str,
) -> Result<(), AppError> {
    let updated = sqlx::query(
        "UPDATE session_prompts SET state = 'ended', ended_at = ? WHERE id = ? AND state = 'running'",
    )
    .bind(now_millis())
    .bind(prompt_id)
    .execute(&state.pool)
    .await?;
    if updated.rows_affected() == 0 {
        return Ok(()); // already ended (timer/stop race)
    }
    let (session_id,): (i64,) =
        sqlx::query_as("SELECT session_id FROM session_prompts WHERE id = ?")
            .bind(prompt_id)
            .fetch_one(&state.pool)
            .await?;
    state.ws.broadcast(
        &format!("session:{session_id}"),
        "prompt.ended",
        serde_json::json!({ "session_id": session_id, "prompt_id": prompt_id, "reason": reason }),
    );
    Ok(())
}

/// Server-authoritative timer: sleeps until the deadline, then ends the
/// prompt. Rehydrated at boot for prompts still marked running.
pub fn spawn_prompt_timer(state: AppState, prompt_id: i64, ends_at: i64) {
    tokio::spawn(async move {
        let wait_ms = (ends_at - now_millis()).max(0) as u64;
        tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
        if let Err(e) = end_prompt_inner(&state, prompt_id, "timer").await {
            tracing::error!("failed to end prompt {prompt_id}: {}", e.message);
        }
    });
}

/// Called once at startup: re-arm timers for prompts left running.
pub async fn rehydrate_timers(state: &AppState) -> Result<(), sqlx::Error> {
    let rows: Vec<(i64, Option<i64>)> =
        sqlx::query_as("SELECT id, ends_at FROM session_prompts WHERE state = 'running'")
            .bind(0)
            .fetch_all(&state.pool)
            .await?;
    for (prompt_id, ends_at) in rows {
        if let Some(ends_at) = ends_at {
            spawn_prompt_timer(state.clone(), prompt_id, ends_at);
        }
    }
    Ok(())
}

pub async fn save_submission(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(prompt_id): Path<i64>,
    Json(req): Json<SaveSubmissionRequest>,
) -> Result<StatusCode, AppError> {
    let (session_id, prompt_state, _) = prompt_session(&state, prompt_id).await?;
    require_session_access(&state, session_id, auth.user_id).await?;
    if prompt_state != "running" {
        return Err(AppError::bad_request(
            "not_running",
            "writing is only saved while the prompt runs",
        ));
    }
    let doc_text = validate_doc(&req.doc)?;

    let now = now_millis();
    let (submission_id,): (i64,) = sqlx::query_as(
        "INSERT INTO session_submissions (prompt_id, user_id, doc, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(prompt_id, user_id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at
         RETURNING id",
    )
    .bind(prompt_id)
    .bind(auth.user_id.0)
    .bind(&doc_text)
    .bind(now)
    .fetch_one(&state.pool)
    .await?;

    // Safety-net snapshot at most once per interval.
    let last: Option<(i64,)> =
        sqlx::query_as("SELECT MAX(captured_at) FROM submission_snapshots WHERE submission_id = ?")
            .bind(submission_id)
            .fetch_optional(&state.pool)
            .await?
            .filter(|(t,)| *t > 0);
    if last.is_none_or(|(t,)| now - t >= SNAPSHOT_INTERVAL_MS) {
        sqlx::query(
            "INSERT INTO submission_snapshots (submission_id, doc, captured_at) VALUES (?, ?, ?)",
        )
        .bind(submission_id)
        .bind(&doc_text)
        .bind(now)
        .execute(&state.pool)
        .await?;
    }

    state.ws.broadcast(
        &format!("session:{session_id}"),
        "submission.updated",
        serde_json::json!({ "prompt_id": prompt_id, "user_id": auth.user_id, "updated_at": now }),
    );
    Ok(StatusCode::NO_CONTENT)
}
