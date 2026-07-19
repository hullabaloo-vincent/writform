//! Authorization helpers shared by REST handlers and the WS hub.

use sqlx::SqlitePool;
use writform_proto::chat::GroupRole;
use writform_proto::{ChannelId, GroupId, UserId};

use crate::error::AppError;

fn role_from_str(s: &str) -> GroupRole {
    if s == "admin" {
        GroupRole::Admin
    } else {
        GroupRole::Member
    }
}

pub async fn member_role(
    pool: &SqlitePool,
    group: GroupId,
    user: UserId,
) -> Result<Option<GroupRole>, sqlx::Error> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
            .bind(group.0)
            .bind(user.0)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(r,)| role_from_str(&r)))
}

pub async fn require_member(
    pool: &SqlitePool,
    group: GroupId,
    user: UserId,
) -> Result<GroupRole, AppError> {
    member_role(pool, group, user).await?.ok_or_else(|| {
        AppError::new(
            axum::http::StatusCode::FORBIDDEN,
            "not_a_member",
            "you are not a member of this group",
        )
    })
}

pub async fn require_admin(
    pool: &SqlitePool,
    group: GroupId,
    user: UserId,
) -> Result<(), AppError> {
    match require_member(pool, group, user).await? {
        GroupRole::Admin => Ok(()),
        GroupRole::Member => Err(AppError::new(
            axum::http::StatusCode::FORBIDDEN,
            "not_an_admin",
            "group admin required",
        )),
    }
}

/// Can `user` read/post in `channel`? Group channels require membership; DMs
/// require being one of the pair. Returns the channel's group (None for DMs).
pub async fn require_channel_access(
    pool: &SqlitePool,
    channel: ChannelId,
    user: UserId,
) -> Result<Option<GroupId>, AppError> {
    let row: Option<(Option<i64>, String)> =
        sqlx::query_as("SELECT group_id, kind FROM channels WHERE id = ?")
            .bind(channel.0)
            .fetch_optional(pool)
            .await?;
    let Some((group_id, kind)) = row else {
        return Err(AppError::new(
            axum::http::StatusCode::NOT_FOUND,
            "no_such_channel",
            "channel not found",
        ));
    };

    if kind == "dm" {
        let in_pair: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM dm_pairs WHERE channel_id = ? AND (user_a = ? OR user_b = ?)",
        )
        .bind(channel.0)
        .bind(user.0)
        .bind(user.0)
        .fetch_optional(pool)
        .await?;
        if in_pair.is_none() {
            return Err(AppError::new(
                axum::http::StatusCode::FORBIDDEN,
                "not_your_dm",
                "not a participant of this conversation",
            ));
        }
        return Ok(None);
    }

    let group =
        GroupId(group_id.ok_or_else(|| AppError::internal("non-dm channel without group"))?);
    require_member(pool, group, user).await?;
    Ok(Some(group))
}

/// Group ids the user belongs to (used for presence fan-out).
pub async fn user_groups(pool: &SqlitePool, user: UserId) -> Result<Vec<GroupId>, sqlx::Error> {
    let rows: Vec<(i64,)> = sqlx::query_as("SELECT group_id FROM group_members WHERE user_id = ?")
        .bind(user.0)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|(id,)| GroupId(id)).collect())
}

/// Build a wire `UserRef` from the standard user columns
/// `(username, display_name, avatar_attachment_id, accent_color)`.
pub fn user_ref(
    id: writform_proto::UserId,
    username: String,
    display_name: Option<String>,
    avatar_attachment_id: Option<i64>,
    accent_color: Option<String>,
) -> writform_proto::chat::UserRef {
    writform_proto::chat::UserRef {
        id,
        username,
        display_name,
        avatar_attachment_id: avatar_attachment_id.map(writform_proto::AttachmentId),
        accent_color,
    }
}
