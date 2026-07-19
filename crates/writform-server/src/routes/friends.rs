use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use writform_proto::chat::UserRef;
use writform_proto::friends::{
    DmChannel, Friend, FriendRequest, FriendRequests, SendFriendRequest,
};
use writform_proto::{ChannelId, UserId};

use crate::auth::AuthUser;
use crate::db::now_millis;
use crate::error::AppError;
use crate::routes::AppState;

fn canonical(a: i64, b: i64) -> (i64, i64) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

async fn user_ref(state: &AppState, id: i64) -> Result<UserRef, AppError> {
    let (username, display_name, avatar, accent): (
        String,
        Option<String>,
        Option<i64>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT username, display_name, avatar_attachment_id, accent_color FROM users WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    Ok(crate::perms::user_ref(
        UserId(id),
        username,
        display_name,
        avatar,
        accent,
    ))
}

async fn are_friends(state: &AppState, a: i64, b: i64) -> Result<bool, AppError> {
    let (ua, ub) = canonical(a, b);
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?")
            .bind(ua)
            .bind(ub)
            .fetch_optional(&state.pool)
            .await?;
    Ok(row.is_some())
}

pub async fn send_request(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<SendFriendRequest>,
) -> Result<Json<FriendRequest>, AppError> {
    let target: Option<(i64,)> = sqlx::query_as("SELECT id FROM users WHERE username = ?")
        .bind(req.username.trim())
        .fetch_optional(&state.pool)
        .await?;
    let Some((target_id,)) = target else {
        return Err(AppError::bad_request(
            "no_such_user",
            "no user with that username",
        ));
    };
    if target_id == auth.user_id.0 {
        return Err(AppError::bad_request("self_friend", "that's you"));
    }
    if are_friends(&state, auth.user_id.0, target_id).await? {
        return Err(AppError::bad_request(
            "already_friends",
            "you are already friends",
        ));
    }

    // An opposite-direction pending request auto-accepts instead.
    let opposite: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM friend_requests WHERE from_user = ? AND to_user = ?")
            .bind(target_id)
            .bind(auth.user_id.0)
            .fetch_optional(&state.pool)
            .await?;
    if let Some((req_id,)) = opposite {
        return accept_inner(state, auth.user_id.0, req_id).await;
    }

    let now = now_millis();
    let result = sqlx::query_scalar::<_, i64>(
        "INSERT INTO friend_requests (from_user, to_user, created_at) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(auth.user_id.0)
    .bind(target_id)
    .bind(now)
    .fetch_one(&state.pool)
    .await;
    let id = match result {
        Ok(id) => id,
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError::bad_request(
                "already_sent",
                "request already pending",
            ));
        }
        Err(e) => return Err(e.into()),
    };

    let request = FriendRequest {
        id,
        from: user_ref(&state, auth.user_id.0).await?,
        to: user_ref(&state, target_id).await?,
        created_at: now,
    };
    state.ws.broadcast(
        &format!("user:{target_id}"),
        "friend.request",
        serde_json::to_value(&request).expect("serializable"),
    );
    Ok(Json(request))
}

pub async fn list_requests(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<FriendRequests>, AppError> {
    type Row = (i64, i64, i64, i64);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, from_user, to_user, created_at FROM friend_requests
         WHERE from_user = ? OR to_user = ? ORDER BY created_at DESC",
    )
    .bind(auth.user_id.0)
    .bind(auth.user_id.0)
    .fetch_all(&state.pool)
    .await?;

    let mut incoming = Vec::new();
    let mut outgoing = Vec::new();
    for (id, from, to, created_at) in rows {
        let request = FriendRequest {
            id,
            from: user_ref(&state, from).await?,
            to: user_ref(&state, to).await?,
            created_at,
        };
        if to == auth.user_id.0 {
            incoming.push(request);
        } else {
            outgoing.push(request);
        }
    }
    Ok(Json(FriendRequests { incoming, outgoing }))
}

async fn accept_inner(
    state: AppState,
    me: i64,
    request_id: i64,
) -> Result<Json<FriendRequest>, AppError> {
    let row: Option<(i64, i64, i64)> = sqlx::query_as(
        "SELECT id, from_user, to_user FROM friend_requests WHERE id = ? AND to_user = ?",
    )
    .bind(request_id)
    .bind(me)
    .fetch_optional(&state.pool)
    .await?;
    let Some((id, from, to)) = row else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_request",
            "request not found",
        ));
    };

    let now = now_millis();
    let (a, b) = canonical(from, to);
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM friend_requests WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)")
        .bind(a)
        .bind(b)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let request = FriendRequest {
        id,
        from: user_ref(&state, from).await?,
        to: user_ref(&state, to).await?,
        created_at: now,
    };
    for uid in [from, to] {
        state.ws.broadcast(
            &format!("user:{uid}"),
            "friend.accepted",
            serde_json::to_value(&request).expect("serializable"),
        );
    }
    Ok(Json(request))
}

pub async fn accept_request(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(request_id): Path<i64>,
) -> Result<Json<FriendRequest>, AppError> {
    accept_inner(state, auth.user_id.0, request_id).await
}

/// Decline (as recipient) or cancel (as sender).
pub async fn delete_request(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(request_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    sqlx::query("DELETE FROM friend_requests WHERE id = ? AND (from_user = ? OR to_user = ?)")
        .bind(request_id)
        .bind(auth.user_id.0)
        .bind(auth.user_id.0)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_friends(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Vec<Friend>>, AppError> {
    let rows: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT user_a, user_b, created_at FROM friendships WHERE user_a = ? OR user_b = ?",
    )
    .bind(auth.user_id.0)
    .bind(auth.user_id.0)
    .fetch_all(&state.pool)
    .await?;
    let mut friends = Vec::new();
    for (a, b, since) in rows {
        let other = if a == auth.user_id.0 { b } else { a };
        let status = crate::ws::effective_status(&state, UserId(other)).await;
        friends.push(Friend {
            online: status.is_some(),
            status,
            user: user_ref(&state, other).await?,
            since,
        });
    }
    Ok(Json(friends))
}

pub async fn remove_friend(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(user_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let (a, b) = canonical(auth.user_id.0, user_id);
    sqlx::query("DELETE FROM friendships WHERE user_a = ? AND user_b = ?")
        .bind(a)
        .bind(b)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &format!("user:{user_id}"),
        "friend.removed",
        serde_json::json!({ "user_id": auth.user_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

/// Get or create the DM channel with a friend.
pub async fn open_dm(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(user_id): Path<i64>,
) -> Result<Json<DmChannel>, AppError> {
    if !are_friends(&state, auth.user_id.0, user_id).await? {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "not_friends",
            "you can only DM friends",
        ));
    }
    let (a, b) = canonical(auth.user_id.0, user_id);
    let existing: Option<(i64,)> =
        sqlx::query_as("SELECT channel_id FROM dm_pairs WHERE user_a = ? AND user_b = ?")
            .bind(a)
            .bind(b)
            .fetch_optional(&state.pool)
            .await?;
    let channel_id = match existing {
        Some((id,)) => id,
        None => {
            let now = now_millis();
            let mut tx = state.pool.begin().await?;
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
            tx.commit().await?;
            id
        }
    };
    Ok(Json(DmChannel {
        channel_id: ChannelId(channel_id),
        peer: user_ref(&state, user_id).await?,
    }))
}

pub async fn list_dms(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Vec<DmChannel>>, AppError> {
    let rows: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT channel_id, user_a, user_b FROM dm_pairs WHERE user_a = ? OR user_b = ?",
    )
    .bind(auth.user_id.0)
    .bind(auth.user_id.0)
    .fetch_all(&state.pool)
    .await?;
    let mut dms = Vec::new();
    for (channel_id, a, b) in rows {
        let other = if a == auth.user_id.0 { b } else { a };
        dms.push(DmChannel {
            channel_id: ChannelId(channel_id),
            peer: user_ref(&state, other).await?,
        });
    }
    Ok(Json(dms))
}
