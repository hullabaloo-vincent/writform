//! Collaborative documents: Yjs CRDT content synced through
//! `POST /documents/{id}/updates` + the `document:{id}` room, TipTap JSON
//! version snapshots, read/write shares (friends and groups), and anchored
//! feedback threads (docs/documents-plan.md).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::chat::UserRef;
use crate::UnixMillis;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Document {
    #[ts(type = "number")]
    pub id: i64,
    pub owner: UserRef,
    pub title: String,
    /// `none` | `screenplay` | `stageplay` | `manuscript` | `poetry`.
    pub format: String,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
    #[ts(type = "number")]
    pub updated_at: UnixMillis,
}

/// List entry: a document plus the caller's access to it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentListItem {
    pub document: Document,
    /// `owner` | `write` | `read`.
    pub my_access: String,
}

/// Detail for opening: compacted Yjs state (update v1, base64) current
/// through `seq`; apply then subscribe to `document:{id}` for live updates.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentDetail {
    pub document: Document,
    /// `owner` | `write` | `read`.
    pub my_access: String,
    pub state_b64: String,
    #[ts(type = "number")]
    pub seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateDocumentRequest {
    pub title: String,
    #[serde(default)]
    pub format: Option<String>,
}

/// Partial update of document metadata (write access required).
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateDocumentRequest {
    pub title: Option<String>,
    pub format: Option<String>,
}

/// One merged batch of local Yjs edits (update v1, base64, ≤ 256 KB).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AppendUpdateRequest {
    pub update_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AppendUpdateResponse {
    #[ts(type = "number")]
    pub seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentUpdateRow {
    #[ts(type = "number")]
    pub seq: i64,
    pub update_b64: String,
}

/// Catch-up tail from `GET /documents/{id}/updates?since=N`. `truncated`
/// means rows before the requested point were compacted away — reload the
/// full document state instead of applying the tail.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentUpdateBatch {
    pub updates: Vec<DocumentUpdateRow>,
    pub truncated: bool,
}

/// Ephemeral cursor/selection presence (y-protocols awareness, base64).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AwarenessRequest {
    pub data_b64: String,
}

/// TipTap JSON snapshot for version history. Without `name`, an automatic
/// snapshot (rate-limited and deduplicated); with `name`, always stored.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SnapshotRequest {
    pub doc_json: String,
    #[serde(default)]
    pub name: Option<String>,
    /// `auto` | `named` | `draft`. Omitted requests infer auto/named.
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentVersionMeta {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub doc_id: i64,
    /// `auto` | `named`.
    pub kind: String,
    pub name: Option<String>,
    #[ts(type = "number")]
    pub changed_blocks: i64,
    #[ts(type = "number")]
    pub added_words: i64,
    #[ts(type = "number")]
    pub removed_words: i64,
    pub created_by: UserRef,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentActivity {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub doc_id: i64,
    pub kind: String,
    pub actor: UserRef,
    pub subject_kind: Option<String>,
    #[ts(type = "number | null")]
    pub subject_id: Option<i64>,
    pub subject_name: Option<String>,
    pub detail: Option<String>,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentVersion {
    pub meta: DocumentVersionMeta,
    pub doc_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentShare {
    #[ts(type = "number")]
    pub doc_id: i64,
    /// `user` | `group`.
    pub subject_kind: String,
    #[ts(type = "number")]
    pub subject_id: i64,
    /// Display name of the user or group, for share lists.
    pub subject_name: String,
    /// `read` | `write`.
    pub access: String,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SetShareRequest {
    /// `user` | `group`.
    pub subject_kind: String,
    #[ts(type = "number")]
    pub subject_id: i64,
    /// `read` | `write`.
    pub access: String,
}

/// A feedback thread: root comment plus replies, optionally anchored to a
/// text selection via Yjs relative positions (base64) with a plain-text
/// excerpt kept for when the referenced text later changes.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentThread {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub doc_id: i64,
    pub author: UserRef,
    pub anchor_b64: Option<String>,
    pub head_b64: Option<String>,
    pub excerpt: Option<String>,
    pub resolved: bool,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
    pub messages: Vec<DocumentThreadMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentThreadMessage {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub thread_id: i64,
    pub author: UserRef,
    pub content: String,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateThreadRequest {
    pub content: String,
    #[serde(default)]
    pub anchor_b64: Option<String>,
    #[serde(default)]
    pub head_b64: Option<String>,
    #[serde(default)]
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReplyThreadRequest {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateThreadRequest {
    pub resolved: bool,
}
