//! Canvas / storyboard boards: a board belongs to a group; elements are
//! server-authoritative rows updated last-write-wins and fanned out over the
//! `canvas:{board_id}` room (see docs/canvas-plan.md).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::chat::UserRef;
use crate::{GroupId, UnixMillis, UserId};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CanvasBoard {
    #[ts(type = "number")]
    pub id: i64,
    pub group_id: GroupId,
    pub creator: UserRef,
    pub name: String,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

/// One element on a board. `kind` is one of: `sticky`, `text`, `frame`,
/// `connector`. Connectors ignore x/y/w/h and reference two other elements.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CanvasElement {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub board_id: i64,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Stacking order; higher renders on top.
    #[ts(type = "number")]
    pub z: i64,
    pub text: String,
    /// Sticky color key (e.g. "yellow"); empty for other kinds.
    pub color: String,
    #[ts(type = "number | null")]
    pub from_id: Option<i64>,
    #[ts(type = "number | null")]
    pub to_id: Option<i64>,
    pub updated_by: UserId,
    #[ts(type = "number")]
    pub updated_at: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BoardDetail {
    pub board: CanvasBoard,
    pub elements: Vec<CanvasElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateBoardRequest {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateElementRequest {
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub text: String,
    pub color: String,
    #[ts(type = "number | null")]
    pub from_id: Option<i64>,
    #[ts(type = "number | null")]
    pub to_id: Option<i64>,
}

/// Partial update; omitted fields keep their value (last write wins).
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateElementRequest {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    #[ts(type = "number | null")]
    pub z: Option<i64>,
    pub text: Option<String>,
    pub color: Option<String>,
}
