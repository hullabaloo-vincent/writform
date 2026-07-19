use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use writform_proto::chat::{CreateEmoteRequest, Emote};
use writform_proto::{AttachmentId, GroupId};

use crate::auth::AuthUser;
use crate::error::AppError;
use crate::perms;
use crate::routes::AppState;

pub async fn list_emotes(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(group_id): Path<i64>,
) -> Result<Json<Vec<Emote>>, AppError> {
    let group = GroupId(group_id);
    perms::require_member(&state.pool, group, auth.user_id).await?;
    let rows: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT id, name, attachment_id FROM emotes WHERE group_id = ? ORDER BY name",
    )
    .bind(group.0)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, name, attachment_id)| Emote {
                id,
                group_id: group,
                name,
                attachment_id: AttachmentId(attachment_id),
            })
            .collect(),
    ))
}

pub async fn create_emote(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(group_id): Path<i64>,
    Json(req): Json<CreateEmoteRequest>,
) -> Result<Json<Emote>, AppError> {
    let group = GroupId(group_id);
    perms::require_admin(&state.pool, group, auth.user_id).await?;
    let name = req.name.trim().to_lowercase();
    if name.is_empty()
        || name.len() > 32
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(AppError::bad_request(
            "invalid_name",
            "emote names are 1-32 chars: letters, digits, underscore",
        ));
    }
    let result = sqlx::query_scalar::<_, i64>(
        "INSERT INTO emotes (group_id, name, attachment_id) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(group.0)
    .bind(&name)
    .bind(req.attachment_id.0)
    .fetch_one(&state.pool)
    .await;
    let id = match result {
        Ok(id) => id,
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError::bad_request(
                "name_taken",
                "an emote with that name exists",
            ));
        }
        Err(e) => return Err(e.into()),
    };

    let emote = Emote {
        id,
        group_id: group,
        name,
        attachment_id: req.attachment_id,
    };
    state.ws.broadcast(
        &format!("group:{group_id}"),
        "emote.created",
        serde_json::to_value(&emote).expect("serializable"),
    );
    Ok(Json(emote))
}

pub async fn delete_emote(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((group_id, emote_id)): Path<(i64, i64)>,
) -> Result<StatusCode, AppError> {
    let group = GroupId(group_id);
    perms::require_admin(&state.pool, group, auth.user_id).await?;
    sqlx::query("DELETE FROM emotes WHERE id = ? AND group_id = ?")
        .bind(emote_id)
        .bind(group.0)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &format!("group:{group_id}"),
        "emote.deleted",
        serde_json::json!({ "group_id": group_id, "emote_id": emote_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}
