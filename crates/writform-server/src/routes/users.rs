//! Public user profiles: what anyone on the server sees on a profile card.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use writform_proto::api::UserProfile;
use writform_proto::UserId;

use crate::auth::AuthUser;
use crate::error::AppError;
use crate::routes::AppState;

pub async fn profile(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(user_id): Path<i64>,
) -> Result<Json<UserProfile>, AppError> {
    type Row = (
        i64,
        String,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
        i64,
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT id, username, display_name, avatar_attachment_id, banner_attachment_id,
         accent_color, bio, created_at FROM users WHERE id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((id, username, display_name, avatar, banner, accent, bio, created_at)) = row else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_user",
            "user not found",
        ));
    };
    Ok(Json(UserProfile {
        id: UserId(id),
        username,
        display_name,
        avatar_attachment_id: avatar.map(writform_proto::AttachmentId),
        banner_attachment_id: banner.map(writform_proto::AttachmentId),
        accent_color: accent,
        bio,
        status: crate::ws::effective_status(&state, UserId(id)).await,
        created_at,
    }))
}
