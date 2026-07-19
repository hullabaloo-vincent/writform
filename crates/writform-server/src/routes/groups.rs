use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use writform_proto::chat::{
    CreateGroupRequest, CreateInviteRequest, Group, GroupRole, Invite, Member, PresenceSnapshot,
    RedeemInviteRequest, SetRoleRequest, UserRef,
};
use writform_proto::{GroupId, UserId};

use crate::auth::AuthUser;
use crate::db::now_millis;
use crate::error::AppError;
use crate::perms;
use crate::routes::AppState;

fn role_str(role: GroupRole) -> &'static str {
    match role {
        GroupRole::Admin => "admin",
        GroupRole::Member => "member",
    }
}

pub async fn create_group(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<CreateGroupRequest>,
) -> Result<Json<Group>, AppError> {
    let name = req.name.trim();
    if name.is_empty() || name.len() > 64 {
        return Err(AppError::bad_request(
            "invalid_name",
            "group name must be 1-64 characters",
        ));
    }
    let now = now_millis();
    let mut tx = state.pool.begin().await?;
    let group_id: i64 = sqlx::query_scalar(
        "INSERT INTO groups (name, owner_id, created_at) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(name)
    .bind(auth.user_id.0)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)",
    )
    .bind(group_id)
    .bind(auth.user_id.0)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    // Every group starts with a #general channel.
    sqlx::query("INSERT INTO channels (group_id, kind, name, position, created_at) VALUES (?, 'text', 'general', 0, ?)")
        .bind(group_id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(Group {
        id: GroupId(group_id),
        name: name.to_string(),
        owner_id: auth.user_id,
        my_role: GroupRole::Admin,
        created_at: now,
    }))
}

pub async fn my_groups(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Vec<Group>>, AppError> {
    let rows: Vec<(i64, String, i64, i64, String)> = sqlx::query_as(
        "SELECT g.id, g.name, g.owner_id, g.created_at, m.role
         FROM groups g JOIN group_members m ON m.group_id = g.id
         WHERE m.user_id = ? ORDER BY g.created_at",
    )
    .bind(auth.user_id.0)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, name, owner_id, created_at, role)| Group {
                id: GroupId(id),
                name,
                owner_id: UserId(owner_id),
                my_role: if role == "admin" {
                    GroupRole::Admin
                } else {
                    GroupRole::Member
                },
                created_at,
            })
            .collect(),
    ))
}

pub async fn members(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(group_id): Path<i64>,
) -> Result<Json<Vec<Member>>, AppError> {
    let group = GroupId(group_id);
    perms::require_member(&state.pool, group, auth.user_id).await?;
    let rows: Vec<(i64, String, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT u.id, u.username, u.display_name, m.role, m.joined_at
         FROM group_members m JOIN users u ON u.id = m.user_id
         WHERE m.group_id = ? ORDER BY m.joined_at",
    )
    .bind(group.0)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, username, display_name, role, joined_at)| Member {
                user: UserRef {
                    id: UserId(id),
                    username,
                    display_name,
                },
                role: if role == "admin" {
                    GroupRole::Admin
                } else {
                    GroupRole::Member
                },
                joined_at,
            })
            .collect(),
    ))
}

pub async fn presence(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(group_id): Path<i64>,
) -> Result<Json<PresenceSnapshot>, AppError> {
    let group = GroupId(group_id);
    perms::require_member(&state.pool, group, auth.user_id).await?;
    let rows: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM group_members WHERE group_id = ?")
        .bind(group.0)
        .fetch_all(&state.pool)
        .await?;
    let candidates: Vec<UserId> = rows.into_iter().map(|(id,)| UserId(id)).collect();
    Ok(Json(PresenceSnapshot {
        online: state.ws.online_among(&candidates),
    }))
}

pub async fn create_invite(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(group_id): Path<i64>,
    Json(req): Json<CreateInviteRequest>,
) -> Result<Json<Invite>, AppError> {
    let group = GroupId(group_id);
    perms::require_admin(&state.pool, group, auth.user_id).await?;

    // Short, human-shareable code.
    let code: String = {
        use rand::Rng;
        const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
        let mut rng = rand::thread_rng();
        (0..8)
            .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
            .collect()
    };
    let now = now_millis();
    let expires_at = req.expires_in_seconds.map(|s| now + s * 1000);
    sqlx::query(
        "INSERT INTO invites (group_id, code, created_by, expires_at, max_uses, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(group.0)
    .bind(&code)
    .bind(auth.user_id.0)
    .bind(expires_at)
    .bind(req.max_uses)
    .bind(now)
    .execute(&state.pool)
    .await?;
    Ok(Json(Invite {
        code,
        expires_at,
        max_uses: req.max_uses,
        use_count: 0,
        revoked: false,
    }))
}

pub async fn redeem_invite(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<RedeemInviteRequest>,
) -> Result<Json<Group>, AppError> {
    let now = now_millis();
    type InviteRow = (i64, i64, Option<i64>, Option<i64>, i64, i64);
    let row: Option<InviteRow> = sqlx::query_as(
        "SELECT i.id, i.group_id, i.expires_at, i.max_uses, i.use_count, i.revoked
         FROM invites i WHERE i.code = ?",
    )
    .bind(req.code.trim())
    .fetch_optional(&state.pool)
    .await?;
    let Some((invite_id, group_id, expires_at, max_uses, use_count, revoked)) = row else {
        return Err(AppError::bad_request(
            "invalid_invite",
            "unknown invite code",
        ));
    };
    if revoked != 0
        || expires_at.is_some_and(|e| e < now)
        || max_uses.is_some_and(|m| use_count >= m)
    {
        return Err(AppError::bad_request(
            "invalid_invite",
            "this invite is no longer valid",
        ));
    }
    if perms::member_role(&state.pool, GroupId(group_id), auth.user_id)
        .await?
        .is_some()
    {
        return Err(AppError::bad_request(
            "already_member",
            "you are already in this group",
        ));
    }

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
    )
    .bind(group_id)
    .bind(auth.user_id.0)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE invites SET use_count = use_count + 1 WHERE id = ?")
        .bind(invite_id)
        .execute(&mut *tx)
        .await?;
    let (name, owner_id, created_at): (String, i64, i64) =
        sqlx::query_as("SELECT name, owner_id, created_at FROM groups WHERE id = ?")
            .bind(group_id)
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;

    // Tell current members someone joined.
    state.ws.broadcast(
        &format!("group:{group_id}"),
        "member.joined",
        serde_json::json!({ "group_id": group_id, "user_id": auth.user_id }),
    );

    Ok(Json(Group {
        id: GroupId(group_id),
        name,
        owner_id: UserId(owner_id),
        my_role: GroupRole::Member,
        created_at,
    }))
}

pub async fn kick_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((group_id, target)): Path<(i64, i64)>,
) -> Result<StatusCode, AppError> {
    let group = GroupId(group_id);
    perms::require_admin(&state.pool, group, auth.user_id).await?;
    let (owner_id,): (i64,) = sqlx::query_as("SELECT owner_id FROM groups WHERE id = ?")
        .bind(group.0)
        .fetch_one(&state.pool)
        .await?;
    if target == owner_id {
        return Err(AppError::bad_request(
            "cannot_kick_owner",
            "the group owner cannot be kicked",
        ));
    }
    sqlx::query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
        .bind(group.0)
        .bind(target)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &format!("group:{group_id}"),
        "member.left",
        serde_json::json!({ "group_id": group_id, "user_id": target, "kicked": true }),
    );
    // Tell the kicked user directly (their group list changed).
    state.ws.broadcast(
        &format!("user:{target}"),
        "group.removed",
        serde_json::json!({ "group_id": group_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn set_role(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((group_id, target)): Path<(i64, i64)>,
    Json(req): Json<SetRoleRequest>,
) -> Result<StatusCode, AppError> {
    let group = GroupId(group_id);
    perms::require_admin(&state.pool, group, auth.user_id).await?;
    let (owner_id,): (i64,) = sqlx::query_as("SELECT owner_id FROM groups WHERE id = ?")
        .bind(group.0)
        .fetch_one(&state.pool)
        .await?;
    if target == owner_id && !matches!(req.role, GroupRole::Admin) {
        return Err(AppError::bad_request(
            "owner_is_admin",
            "the owner is always an admin",
        ));
    }
    sqlx::query("UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?")
        .bind(role_str(req.role))
        .bind(group.0)
        .bind(target)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &format!("group:{group_id}"),
        "member.role_changed",
        serde_json::json!({ "group_id": group_id, "user_id": target, "role": role_str(req.role) }),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn leave_group(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(group_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let group = GroupId(group_id);
    perms::require_member(&state.pool, group, auth.user_id).await?;
    let (owner_id,): (i64,) = sqlx::query_as("SELECT owner_id FROM groups WHERE id = ?")
        .bind(group.0)
        .fetch_one(&state.pool)
        .await?;
    if auth.user_id.0 == owner_id {
        return Err(AppError::bad_request(
            "owner_cannot_leave",
            "transfer or delete the group instead",
        ));
    }
    sqlx::query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
        .bind(group.0)
        .bind(auth.user_id.0)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &format!("group:{group_id}"),
        "member.left",
        serde_json::json!({ "group_id": group_id, "user_id": auth.user_id, "kicked": false }),
    );
    Ok(StatusCode::NO_CONTENT)
}
