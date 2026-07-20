//! Canvas boards: group-scoped storyboards with server-authoritative
//! elements. Mutations over REST; `canvas.*` events fan out to the
//! `canvas:{board_id}` room (and board list changes to `group:{id}`).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use writform_proto::canvas::{
    BoardDetail, CanvasBoard, CanvasElement, CreateBoardRequest, CreateElementRequest,
    UpdateElementRequest,
};
use writform_proto::{GroupId, UserId};

use crate::auth::AuthUser;
use crate::db::now_millis;
use crate::error::AppError;
use crate::perms;
use crate::routes::AppState;

/// `image` stores an attachment id in `text`; `link` stores a URL in
/// `text`; `document` stores a JSON reference `{document_id, mode, …}`.
const ELEMENT_KINDS: &[&str] = &[
    "sticky",
    "text",
    "frame",
    "connector",
    "image",
    "link",
    "document",
];
const MAX_TEXT: usize = 4000;
const MAX_ELEMENTS_PER_BOARD: i64 = 2000;

async fn require_group_member(
    state: &AppState,
    group: GroupId,
    user: UserId,
) -> Result<(), AppError> {
    if perms::member_role(&state.pool, group, user)
        .await?
        .is_some()
    {
        Ok(())
    } else {
        Err(AppError::new(
            StatusCode::FORBIDDEN,
            "not_a_member",
            "you are not a member of this group",
        ))
    }
}

type BoardRow = (
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

fn row_to_board(row: BoardRow) -> CanvasBoard {
    let (id, group_id, name, created_at, creator_id, username, display_name, avatar, accent) = row;
    CanvasBoard {
        id,
        group_id: GroupId(group_id),
        creator: perms::user_ref(UserId(creator_id), username, display_name, avatar, accent),
        name,
        created_at,
    }
}

const BOARD_SELECT: &str = "SELECT b.id, b.group_id, b.name, b.created_at,
    u.id, u.username, u.display_name, u.avatar_attachment_id, u.accent_color
    FROM canvas_boards b JOIN users u ON u.id = b.creator_id";

/// Board access = membership of its group. Returns the board.
async fn require_board_access(
    state: &AppState,
    board_id: i64,
    user: UserId,
) -> Result<CanvasBoard, AppError> {
    let row: Option<BoardRow> = sqlx::query_as(&format!("{BOARD_SELECT} WHERE b.id = ?"))
        .bind(board_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some(row) = row else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_board",
            "board not found",
        ));
    };
    let board = row_to_board(row);
    require_group_member(state, board.group_id, user).await?;
    Ok(board)
}

pub async fn list_boards(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(group_id): Path<i64>,
) -> Result<Json<Vec<CanvasBoard>>, AppError> {
    require_group_member(&state, GroupId(group_id), auth.user_id).await?;
    let rows: Vec<BoardRow> = sqlx::query_as(&format!(
        "{BOARD_SELECT} WHERE b.group_id = ? ORDER BY b.id DESC"
    ))
    .bind(group_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows.into_iter().map(row_to_board).collect()))
}

pub async fn create_board(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(group_id): Path<i64>,
    Json(req): Json<CreateBoardRequest>,
) -> Result<Json<CanvasBoard>, AppError> {
    require_group_member(&state, GroupId(group_id), auth.user_id).await?;
    let name = req.name.trim();
    if name.is_empty() || name.len() > 120 {
        return Err(AppError::bad_request(
            "invalid_name",
            "board name must be 1-120 characters",
        ));
    }

    let now = now_millis();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO canvas_boards (group_id, creator_id, name, created_at)
         VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(group_id)
    .bind(auth.user_id.0)
    .bind(name)
    .bind(now)
    .fetch_one(&state.pool)
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
    .fetch_one(&state.pool)
    .await?;

    let board = CanvasBoard {
        id,
        group_id: GroupId(group_id),
        creator: crate::perms::user_ref(auth.user_id, username, display_name, avatar, accent),
        name: name.to_string(),
        created_at: now,
    };
    state.ws.broadcast(
        &format!("group:{group_id}"),
        "canvas.board.created",
        serde_json::to_value(&board).expect("serializable"),
    );
    Ok(Json(board))
}

fn row_to_element(row: ElementRow) -> CanvasElement {
    let (
        id,
        board_id,
        kind,
        x,
        y,
        w,
        h,
        z,
        text,
        color,
        style,
        from_id,
        to_id,
        updated_by,
        updated_at,
    ) = row;
    CanvasElement {
        id,
        board_id,
        kind,
        x,
        y,
        w,
        h,
        z,
        text,
        color,
        style,
        from_id,
        to_id,
        updated_by: UserId(updated_by),
        updated_at,
    }
}

type ElementRow = (
    i64,
    i64,
    String,
    f64,
    f64,
    f64,
    f64,
    i64,
    String,
    String,
    String,
    Option<i64>,
    Option<i64>,
    i64,
    i64,
);

const ELEMENT_SELECT: &str = "SELECT id, board_id, kind, x, y, w, h, z, text, color, style,
    from_id, to_id, updated_by, updated_at FROM canvas_elements";

pub async fn board_detail(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(board_id): Path<i64>,
) -> Result<Json<BoardDetail>, AppError> {
    let board = require_board_access(&state, board_id, auth.user_id).await?;
    let rows: Vec<ElementRow> = sqlx::query_as(&format!(
        "{ELEMENT_SELECT} WHERE board_id = ? ORDER BY z, id"
    ))
    .bind(board_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(BoardDetail {
        board,
        elements: rows.into_iter().map(row_to_element).collect(),
    }))
}

pub async fn delete_board(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(board_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let board = require_board_access(&state, board_id, auth.user_id).await?;
    let is_admin = matches!(
        perms::member_role(&state.pool, board.group_id, auth.user_id).await?,
        Some(writform_proto::chat::GroupRole::Admin)
    );
    if board.creator.id != auth.user_id && !is_admin {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "not_allowed",
            "only the creator or a group admin may delete a board",
        ));
    }
    sqlx::query("DELETE FROM canvas_boards WHERE id = ?")
        .bind(board_id)
        .execute(&state.pool)
        .await?;
    let data = serde_json::json!({ "board_id": board_id });
    state.ws.broadcast(
        &format!("canvas:{board_id}"),
        "canvas.board.deleted",
        data.clone(),
    );
    state.ws.broadcast(
        &format!("group:{}", board.group_id.0),
        "canvas.board.deleted",
        data,
    );
    Ok(StatusCode::NO_CONTENT)
}

fn validate_text(text: &str) -> Result<(), AppError> {
    if text.len() > MAX_TEXT {
        return Err(AppError::bad_request("text_too_long", "text is too long"));
    }
    Ok(())
}

pub async fn create_element(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(board_id): Path<i64>,
    Json(req): Json<CreateElementRequest>,
) -> Result<Json<CanvasElement>, AppError> {
    require_board_access(&state, board_id, auth.user_id).await?;
    if !ELEMENT_KINDS.contains(&req.kind.as_str()) {
        return Err(AppError::bad_request("bad_kind", "unknown element kind"));
    }
    validate_text(&req.text)?;
    if req.kind == "connector" {
        let (Some(from_id), Some(to_id)) = (req.from_id, req.to_id) else {
            return Err(AppError::bad_request(
                "bad_connector",
                "connectors need from_id and to_id",
            ));
        };
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM canvas_elements WHERE board_id = ? AND id IN (?, ?) AND kind != 'connector'",
        )
        .bind(board_id)
        .bind(from_id)
        .bind(to_id)
        .fetch_one(&state.pool)
        .await?;
        if count != 2 || from_id == to_id {
            return Err(AppError::bad_request(
                "bad_connector",
                "connector endpoints must be two distinct elements on this board",
            ));
        }
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM canvas_elements WHERE board_id = ?")
        .bind(board_id)
        .fetch_one(&state.pool)
        .await?;
    if count >= MAX_ELEMENTS_PER_BOARD {
        return Err(AppError::bad_request("board_full", "board is full"));
    }

    let now = now_millis();
    let z: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(z) + 1, 0) FROM canvas_elements WHERE board_id = ?",
    )
    .bind(board_id)
    .fetch_one(&state.pool)
    .await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO canvas_elements (board_id, kind, x, y, w, h, z, text, color, style, from_id, to_id, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(board_id)
    .bind(&req.kind)
    .bind(req.x)
    .bind(req.y)
    .bind(req.w)
    .bind(req.h)
    .bind(z)
    .bind(&req.text)
    .bind(&req.color)
    .bind(&req.style)
    .bind(req.from_id)
    .bind(req.to_id)
    .bind(auth.user_id.0)
    .bind(now)
    .fetch_one(&state.pool)
    .await?;

    let element = CanvasElement {
        id,
        board_id,
        kind: req.kind,
        x: req.x,
        y: req.y,
        w: req.w,
        h: req.h,
        z,
        text: req.text,
        color: req.color,
        style: req.style,
        from_id: req.from_id,
        to_id: req.to_id,
        updated_by: auth.user_id,
        updated_at: now,
    };
    state.ws.broadcast(
        &format!("canvas:{board_id}"),
        "canvas.element.created",
        serde_json::to_value(&element).expect("serializable"),
    );
    Ok(Json(element))
}

/// Which board an element belongs to (also proves it exists).
async fn element_board(state: &AppState, element_id: i64) -> Result<i64, AppError> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT board_id FROM canvas_elements WHERE id = ?")
        .bind(element_id)
        .fetch_optional(&state.pool)
        .await?;
    row.map(|(b,)| b).ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_element",
            "element not found",
        )
    })
}

pub async fn update_element(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(element_id): Path<i64>,
    Json(req): Json<UpdateElementRequest>,
) -> Result<Json<CanvasElement>, AppError> {
    let board_id = element_board(&state, element_id).await?;
    require_board_access(&state, board_id, auth.user_id).await?;
    if let Some(text) = &req.text {
        validate_text(text)?;
    }

    let now = now_millis();
    sqlx::query(
        "UPDATE canvas_elements SET
            x = COALESCE(?, x), y = COALESCE(?, y),
            w = COALESCE(?, w), h = COALESCE(?, h),
            z = COALESCE(?, z),
            text = COALESCE(?, text), color = COALESCE(?, color),
            style = COALESCE(?, style),
            updated_by = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(req.x)
    .bind(req.y)
    .bind(req.w)
    .bind(req.h)
    .bind(req.z)
    .bind(req.text.as_deref())
    .bind(req.color.as_deref())
    .bind(req.style.as_deref())
    .bind(auth.user_id.0)
    .bind(now)
    .bind(element_id)
    .execute(&state.pool)
    .await?;

    let row: ElementRow = sqlx::query_as(&format!("{ELEMENT_SELECT} WHERE id = ?"))
        .bind(element_id)
        .fetch_one(&state.pool)
        .await?;
    let element = row_to_element(row);
    state.ws.broadcast(
        &format!("canvas:{board_id}"),
        "canvas.element.updated",
        serde_json::to_value(&element).expect("serializable"),
    );
    Ok(Json(element))
}

pub async fn delete_element(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(element_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let board_id = element_board(&state, element_id).await?;
    require_board_access(&state, board_id, auth.user_id).await?;
    // Cascades to connectors referencing this element.
    sqlx::query("DELETE FROM canvas_elements WHERE id = ? OR from_id = ? OR to_id = ?")
        .bind(element_id)
        .bind(element_id)
        .bind(element_id)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &format!("canvas:{board_id}"),
        "canvas.element.deleted",
        serde_json::json!({ "board_id": board_id, "element_id": element_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

/// Live cursor position, relayed and immediately forgotten.
///
/// Deliberately not persisted or rate-limited server-side: it is pure
/// presence, the client throttles it, and a dropped frame self-corrects on
/// the next pointer move. Mirrors how document awareness works.
#[derive(serde::Deserialize)]
pub struct CursorRequest {
    pub x: f64,
    pub y: f64,
}

pub async fn board_cursor(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(board_id): Path<i64>,
    Json(req): Json<CursorRequest>,
) -> Result<StatusCode, AppError> {
    require_board_access(&state, board_id, auth.user_id).await?;
    if !req.x.is_finite() || !req.y.is_finite() {
        return Err(AppError::bad_request("bad_cursor", "cursor must be finite"));
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
    .fetch_one(&state.pool)
    .await?;
    state.ws.broadcast(
        &format!("canvas:{board_id}"),
        "canvas.cursor",
        serde_json::json!({
            "board_id": board_id,
            "user": perms::user_ref(auth.user_id, username, display_name, avatar, accent),
            "x": req.x,
            "y": req.y,
        }),
    );
    Ok(StatusCode::NO_CONTENT)
}
