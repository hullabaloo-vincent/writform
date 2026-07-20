//! Collaborative documents: Yjs CRDT content over the usual "REST mutates,
//! WS distributes" model. Clients POST merged update batches (v1 encoding,
//! base64); the server appends them to a per-document log, fans them out to
//! the `document:{id}` room, and periodically compacts the log into
//! `documents.ydoc_state` with yrs. Version history is client-submitted
//! TipTap JSON snapshots; sharing grants read/write to friends or whole
//! groups; feedback threads anchor to selections via Yjs relative positions.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use writform_proto::chat::UserRef;
use writform_proto::documents::{
    AppendUpdateRequest, AppendUpdateResponse, AwarenessRequest, CreateDocumentRequest,
    CreateThreadRequest, Document, DocumentActivity, DocumentDetail, DocumentListItem,
    DocumentShare, DocumentThread, DocumentThreadMessage, DocumentUpdateBatch, DocumentUpdateRow, DocumentVersion,
    DocumentVersionMeta, ReplyThreadRequest, SetShareRequest, SnapshotRequest,
    UpdateDocumentRequest, UpdateThreadRequest,
};
use writform_proto::{GroupId, UserId};

use crate::auth::AuthUser;
use crate::db::now_millis;
use crate::error::AppError;
use crate::perms;
use crate::routes::AppState;

const FORMATS: &[&str] = &["none", "screenplay", "stageplay", "manuscript", "poetry"];
const MAX_UPDATE_BYTES: usize = 256 * 1024;
const MAX_AWARENESS_BYTES: usize = 8 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_THREAD_CONTENT: usize = 4000;
const AUTO_SNAPSHOT_INTERVAL_MS: i64 = 60_000;
/// Compact once this many update rows sit above the merged state.
const COMPACT_AFTER: i64 = 200;
/// Update rows kept below `last_seq` after compaction so `?since=` catch-up
/// works across brief disconnects; older gaps force a full state reload.
const KEEP_TAIL: i64 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Access {
    Read,
    Write,
    Owner,
}

impl Access {
    fn as_str(self) -> &'static str {
        match self {
            Access::Read => "read",
            Access::Write => "write",
            Access::Owner => "owner",
        }
    }
}

type DocRow = (
    i64,
    i64,
    String,
    String,
    i64,
    i64,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
);

const DOC_SELECT: &str = "SELECT d.id, d.owner_id, d.title, d.format, d.created_at, d.updated_at,
    u.username, u.display_name, u.avatar_attachment_id, u.accent_color
    FROM documents d JOIN users u ON u.id = d.owner_id";

fn row_to_document(row: DocRow) -> (Document, i64) {
    let (
        id,
        owner_id,
        title,
        format,
        created_at,
        updated_at,
        username,
        display_name,
        avatar,
        accent,
    ) = row;
    (
        Document {
            id,
            owner: perms::user_ref(UserId(owner_id), username, display_name, avatar, accent),
            title,
            format,
            created_at,
            updated_at,
        },
        owner_id,
    )
}

async fn fetch_document(state: &AppState, doc_id: i64) -> Result<(Document, i64), AppError> {
    let row: Option<DocRow> = sqlx::query_as(&format!("{DOC_SELECT} WHERE d.id = ?"))
        .bind(doc_id)
        .fetch_optional(&state.pool)
        .await?;
    row.map(row_to_document).ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_document",
            "document not found",
        )
    })
}

/// The caller's access to a document whose owner is already known.
async fn shared_access(
    state: &AppState,
    doc_id: i64,
    owner_id: i64,
    user: UserId,
) -> Result<Option<Access>, AppError> {
    if owner_id == user.0 {
        return Ok(Some(Access::Owner));
    }
    let shares: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT subject_kind, subject_id, access FROM document_shares WHERE doc_id = ?",
    )
    .bind(doc_id)
    .fetch_all(&state.pool)
    .await?;
    let mut my_groups: Option<Vec<GroupId>> = None;
    let mut best: Option<Access> = None;
    for (kind, subject_id, access) in shares {
        let hit = match kind.as_str() {
            "user" => subject_id == user.0,
            "group" => {
                if my_groups.is_none() {
                    my_groups = Some(perms::user_groups(&state.pool, user).await?);
                }
                my_groups
                    .as_ref()
                    .expect("just set")
                    .iter()
                    .any(|g| g.0 == subject_id)
            }
            _ => false,
        };
        if hit {
            let a = if access == "write" {
                Access::Write
            } else {
                Access::Read
            };
            best = Some(best.map_or(a, |b| b.max(a)));
        }
    }
    Ok(best)
}

/// Room permission for `document:{id}` (see `ws::room_allowed`). Unknown
/// documents simply read as "no".
pub async fn can_read(state: &AppState, doc_id: i64, user: UserId) -> Result<bool, AppError> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT owner_id FROM documents WHERE id = ?")
        .bind(doc_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some((owner_id,)) = row else {
        return Ok(false);
    };
    Ok(shared_access(state, doc_id, owner_id, user)
        .await?
        .is_some())
}

/// 404 for unknown documents, 403 without access (or with read-only access
/// when `need_write`). Returns the document and the caller's access.
async fn require_access(
    state: &AppState,
    doc_id: i64,
    user: UserId,
    need_write: bool,
) -> Result<(Document, Access), AppError> {
    let (doc, owner_id) = fetch_document(state, doc_id).await?;
    let Some(access) = shared_access(state, doc_id, owner_id, user).await? else {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "not_allowed",
            "no access to this document",
        ));
    };
    if need_write && access < Access::Write {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "read_only",
            "you have read-only access to this document",
        ));
    }
    Ok((doc, access))
}

fn require_owner(access: Access) -> Result<(), AppError> {
    if access == Access::Owner {
        Ok(())
    } else {
        Err(AppError::new(
            StatusCode::FORBIDDEN,
            "not_owner",
            "only the owner may do this",
        ))
    }
}

async fn fetch_user_ref(state: &AppState, user: UserId) -> Result<UserRef, AppError> {
    let (username, display_name, avatar, accent): (
        String,
        Option<String>,
        Option<i64>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT username, display_name, avatar_attachment_id, accent_color FROM users WHERE id = ?",
    )
    .bind(user.0)
    .fetch_one(&state.pool)
    .await?;
    Ok(perms::user_ref(
        user,
        username,
        display_name,
        avatar,
        accent,
    ))
}

fn doc_room(doc_id: i64) -> String {
    format!("document:{doc_id}")
}

/// Merge a compacted state (if any) and tail updates into one v1 update.
/// Malformed rows are skipped rather than poisoning the document.
fn merge_updates(state_blob: Option<&[u8]>, tail: &[Vec<u8>]) -> Vec<u8> {
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, ReadTxn, StateVector, Transact, Update};
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        if let Some(bytes) = state_blob {
            if let Ok(u) = Update::decode_v1(bytes) {
                let _ = txn.apply_update(u);
            }
        }
        for bytes in tail {
            if let Ok(u) = Update::decode_v1(bytes) {
                let _ = txn.apply_update(u);
            }
        }
    }
    let merged = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    merged
}

// ---------------------------------------------------------------- documents

pub async fn create_document(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<CreateDocumentRequest>,
) -> Result<Json<Document>, AppError> {
    let title = req.title.trim();
    if title.is_empty() || title.len() > 200 {
        return Err(AppError::bad_request(
            "invalid_title",
            "title must be 1-200 characters",
        ));
    }
    let format = req.format.as_deref().unwrap_or("none");
    if !FORMATS.contains(&format) {
        return Err(AppError::bad_request("bad_format", "unknown format"));
    }

    let now = now_millis();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO documents (owner_id, title, format, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(auth.user_id.0)
    .bind(title)
    .bind(format)
    .bind(now)
    .bind(now)
    .fetch_one(&state.pool)
    .await?;
    let (doc, _) = fetch_document(&state, id).await?;
    Ok(Json(doc))
}

/// `DOC_SELECT` columns plus the share's `access`.
type DocShareRow = (
    i64,
    i64,
    String,
    String,
    i64,
    i64,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    String,
);

const DOC_SHARE_SELECT: &str = "SELECT d.id, d.owner_id, d.title, d.format, d.created_at,
    d.updated_at, u.username, u.display_name, u.avatar_attachment_id, u.accent_color, s.access
    FROM documents d JOIN users u ON u.id = d.owner_id
    JOIN document_shares s ON s.doc_id = d.id";

fn share_row_split(r: DocShareRow) -> (DocRow, Access) {
    let access = if r.10 == "write" {
        Access::Write
    } else {
        Access::Read
    };
    ((r.0, r.1, r.2, r.3, r.4, r.5, r.6, r.7, r.8, r.9), access)
}

pub async fn list_documents(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Vec<DocumentListItem>>, AppError> {
    let mut best: std::collections::HashMap<i64, (Document, Access)> =
        std::collections::HashMap::new();
    let add = |row: DocRow,
               access: Access,
               best: &mut std::collections::HashMap<i64, (Document, Access)>| {
        let (doc, _) = row_to_document(row);
        match best.get(&doc.id) {
            Some((_, existing)) if *existing >= access => {}
            _ => {
                best.insert(doc.id, (doc, access));
            }
        }
    };

    let owned: Vec<DocRow> = sqlx::query_as(&format!("{DOC_SELECT} WHERE d.owner_id = ?"))
        .bind(auth.user_id.0)
        .fetch_all(&state.pool)
        .await?;
    for row in owned {
        add(row, Access::Owner, &mut best);
    }

    let user_shared: Vec<DocShareRow> = sqlx::query_as(&format!(
        "{DOC_SHARE_SELECT} WHERE s.subject_kind = 'user' AND s.subject_id = ?"
    ))
    .bind(auth.user_id.0)
    .fetch_all(&state.pool)
    .await?;
    for r in user_shared {
        let (row, access) = share_row_split(r);
        add(row, access, &mut best);
    }

    let groups = perms::user_groups(&state.pool, auth.user_id).await?;
    if !groups.is_empty() {
        let placeholders = vec!["?"; groups.len()].join(", ");
        let sql = format!(
            "{DOC_SHARE_SELECT} WHERE s.subject_kind = 'group' AND s.subject_id IN ({placeholders})"
        );
        let mut q = sqlx::query_as::<_, DocShareRow>(&sql);
        for g in &groups {
            q = q.bind(g.0);
        }
        let rows = q.fetch_all(&state.pool).await?;
        for r in rows {
            let (row, access) = share_row_split(r);
            add(row, access, &mut best);
        }
    }

    let mut items: Vec<DocumentListItem> = best
        .into_values()
        .map(|(document, access)| DocumentListItem {
            document,
            my_access: access.as_str().to_string(),
        })
        .collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.document.updated_at));
    Ok(Json(items))
}

pub async fn document_detail(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
) -> Result<Json<DocumentDetail>, AppError> {
    let (doc, access) = require_access(&state, doc_id, auth.user_id, false).await?;
    let (ydoc_state, state_seq, last_seq): (Option<Vec<u8>>, i64, i64) =
        sqlx::query_as("SELECT ydoc_state, state_seq, last_seq FROM documents WHERE id = ?")
            .bind(doc_id)
            .fetch_one(&state.pool)
            .await?;
    let tail: Vec<(Vec<u8>,)> = sqlx::query_as(
        "SELECT update_data FROM document_updates WHERE doc_id = ? AND seq > ? ORDER BY seq",
    )
    .bind(doc_id)
    .bind(state_seq)
    .fetch_all(&state.pool)
    .await?;
    let tail: Vec<Vec<u8>> = tail.into_iter().map(|(b,)| b).collect();
    let merged = merge_updates(ydoc_state.as_deref(), &tail);
    let now = now_millis();
    let recent_open: Option<(i64,)> = sqlx::query_as(
        "SELECT created_at FROM document_activity
         WHERE doc_id = ? AND actor_id = ? AND kind = 'opened'
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(doc_id)
    .bind(auth.user_id.0)
    .fetch_optional(&state.pool)
    .await?;
    if recent_open.is_none_or(|(at,)| now - at >= 60_000) {
        insert_activity(&state, doc_id, auth.user_id, "opened", None, None, None, None).await?;
    }
    Ok(Json(DocumentDetail {
        document: doc,
        my_access: access.as_str().to_string(),
        state_b64: B64.encode(merged),
        seq: last_seq,
    }))
}

async fn insert_activity(
    state: &AppState,
    doc_id: i64,
    actor: UserId,
    kind: &str,
    subject_kind: Option<&str>,
    subject_id: Option<i64>,
    subject_name: Option<&str>,
    detail: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO document_activity
         (doc_id, kind, actor_id, subject_kind, subject_id, subject_name, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(doc_id)
    .bind(kind)
    .bind(actor.0)
    .bind(subject_kind)
    .bind(subject_id)
    .bind(subject_name)
    .bind(detail)
    .bind(now_millis())
    .execute(&state.pool)
    .await?;
    Ok(())
}

pub async fn update_document(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
    Json(req): Json<UpdateDocumentRequest>,
) -> Result<Json<Document>, AppError> {
    require_access(&state, doc_id, auth.user_id, true).await?;
    if let Some(title) = &req.title {
        let t = title.trim();
        if t.is_empty() || t.len() > 200 {
            return Err(AppError::bad_request(
                "invalid_title",
                "title must be 1-200 characters",
            ));
        }
    }
    if let Some(format) = &req.format {
        if !FORMATS.contains(&format.as_str()) {
            return Err(AppError::bad_request("bad_format", "unknown format"));
        }
    }
    sqlx::query(
        "UPDATE documents SET title = COALESCE(?, title), format = COALESCE(?, format),
         updated_at = ? WHERE id = ?",
    )
    .bind(req.title.as_deref().map(str::trim))
    .bind(req.format.as_deref())
    .bind(now_millis())
    .bind(doc_id)
    .execute(&state.pool)
    .await?;
    let (doc, _) = fetch_document(&state, doc_id).await?;
    state.ws.broadcast(
        &doc_room(doc_id),
        "document.meta",
        serde_json::to_value(&doc).expect("serializable"),
    );
    Ok(Json(doc))
}

pub async fn delete_document(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let (_, access) = require_access(&state, doc_id, auth.user_id, false).await?;
    require_owner(access)?;
    sqlx::query("DELETE FROM documents WHERE id = ?")
        .bind(doc_id)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &doc_room(doc_id),
        "document.deleted",
        serde_json::json!({ "doc_id": doc_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------ updates

pub async fn append_update(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
    Json(req): Json<AppendUpdateRequest>,
) -> Result<Json<AppendUpdateResponse>, AppError> {
    require_access(&state, doc_id, auth.user_id, true).await?;
    let bytes = B64
        .decode(&req.update_b64)
        .map_err(|_| AppError::bad_request("bad_update", "update is not valid base64"))?;
    if bytes.is_empty() || bytes.len() > MAX_UPDATE_BYTES {
        return Err(AppError::bad_request(
            "bad_update",
            "update must be 1 byte to 256 KB",
        ));
    }
    {
        use yrs::updates::decoder::Decode;
        if yrs::Update::decode_v1(&bytes).is_err() {
            return Err(AppError::bad_request(
                "bad_update",
                "update is not a valid yjs v1 update",
            ));
        }
    }

    let now = now_millis();
    // last_seq is the atomic per-document sequence source.
    let seq: i64 = sqlx::query_scalar(
        "UPDATE documents SET last_seq = last_seq + 1, updated_at = ? WHERE id = ?
         RETURNING last_seq",
    )
    .bind(now)
    .bind(doc_id)
    .fetch_one(&state.pool)
    .await?;
    sqlx::query(
        "INSERT INTO document_updates (doc_id, seq, update_data, author_id, created_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(doc_id)
    .bind(seq)
    .bind(&bytes)
    .bind(auth.user_id.0)
    .bind(now)
    .execute(&state.pool)
    .await?;

    state.ws.broadcast(
        &doc_room(doc_id),
        "document.update",
        serde_json::json!({
            "doc_id": doc_id,
            "seq": seq,
            "update_b64": req.update_b64,
            "author": auth.user_id.0,
        }),
    );

    maybe_compact(&state, doc_id).await?;
    Ok(Json(AppendUpdateResponse { seq }))
}

/// Fold the update tail into `ydoc_state` once it grows past COMPACT_AFTER,
/// keeping KEEP_TAIL rows for catch-up.
async fn maybe_compact(state: &AppState, doc_id: i64) -> Result<(), AppError> {
    let (ydoc_state, state_seq, last_seq): (Option<Vec<u8>>, i64, i64) =
        sqlx::query_as("SELECT ydoc_state, state_seq, last_seq FROM documents WHERE id = ?")
            .bind(doc_id)
            .fetch_one(&state.pool)
            .await?;
    if last_seq - state_seq < COMPACT_AFTER {
        return Ok(());
    }
    let tail: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT seq, update_data FROM document_updates WHERE doc_id = ? AND seq > ? ORDER BY seq",
    )
    .bind(doc_id)
    .bind(state_seq)
    .fetch_all(&state.pool)
    .await?;
    // Merge exactly what we read; appends racing past us stay in the tail.
    let merged_through = tail.iter().map(|(s, _)| *s).max().unwrap_or(state_seq);
    let updates: Vec<Vec<u8>> = tail.into_iter().map(|(_, b)| b).collect();
    let merged = merge_updates(ydoc_state.as_deref(), &updates);
    sqlx::query("UPDATE documents SET ydoc_state = ?, state_seq = ? WHERE id = ?")
        .bind(&merged)
        .bind(merged_through)
        .bind(doc_id)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM document_updates WHERE doc_id = ? AND seq <= ?")
        .bind(doc_id)
        .bind(merged_through - KEEP_TAIL)
        .execute(&state.pool)
        .await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct SinceParam {
    #[serde(default)]
    pub since: i64,
}

pub async fn get_updates(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
    Query(params): Query<SinceParam>,
) -> Result<Json<DocumentUpdateBatch>, AppError> {
    require_access(&state, doc_id, auth.user_id, false).await?;
    let (_, last_seq): (i64, i64) =
        sqlx::query_as("SELECT state_seq, last_seq FROM documents WHERE id = ?")
            .bind(doc_id)
            .fetch_one(&state.pool)
            .await?;
    let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT seq, update_data FROM document_updates WHERE doc_id = ? AND seq > ? ORDER BY seq",
    )
    .bind(doc_id)
    .bind(params.since)
    .fetch_all(&state.pool)
    .await?;
    // The tail must be contiguous from since+1; compaction may have pruned it.
    let truncated = match rows.first() {
        Some((first, _)) => *first != params.since + 1,
        None => params.since < last_seq,
    };
    let updates = if truncated {
        vec![]
    } else {
        rows.into_iter()
            .map(|(seq, bytes)| DocumentUpdateRow {
                seq,
                update_b64: B64.encode(bytes),
            })
            .collect()
    };
    Ok(Json(DocumentUpdateBatch { updates, truncated }))
}

pub async fn awareness(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
    Json(req): Json<AwarenessRequest>,
) -> Result<StatusCode, AppError> {
    require_access(&state, doc_id, auth.user_id, false).await?;
    if req.data_b64.len() > MAX_AWARENESS_BYTES * 4 / 3 + 8 {
        return Err(AppError::bad_request(
            "too_large",
            "awareness payload too large",
        ));
    }
    state.ws.broadcast(
        &doc_room(doc_id),
        "document.awareness",
        serde_json::json!({
            "doc_id": doc_id,
            "data_b64": req.data_b64,
            "author": auth.user_id.0,
        }),
    );
    Ok(StatusCode::NO_CONTENT)
}

// ----------------------------------------------------------------- versions

const VERSION_SELECT: &str = "SELECT v.id, v.doc_id, v.kind, v.name,
    v.changed_blocks, v.added_words, v.removed_words, v.created_at,
    u.id, u.username, u.display_name, u.avatar_attachment_id, u.accent_color
    FROM document_versions v JOIN users u ON u.id = v.created_by";

type VersionRow = (
    i64,
    i64,
    String,
    Option<String>,
    i64,
    i64,
    i64,
    i64,
    i64,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
);

fn row_to_version(row: VersionRow) -> DocumentVersionMeta {
    let (id, doc_id, kind, name, changed_blocks, added_words, removed_words, created_at, uid, username, display_name, avatar, accent) = row;
    DocumentVersionMeta {
        id,
        doc_id,
        kind,
        name,
        changed_blocks,
        added_words,
        removed_words,
        created_by: perms::user_ref(UserId(uid), username, display_name, avatar, accent),
        created_at,
    }
}

fn node_text(value: &serde_json::Value, out: &mut String) {
    if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
        out.push_str(text);
    }
    if let Some(children) = value.get("content").and_then(|v| v.as_array()) {
        for child in children {
            node_text(child, out);
        }
    }
}

fn snapshot_blocks(raw: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else { return Vec::new() };
    value
        .get("content")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .map(|node| {
            let mut text = String::new();
            node_text(node, &mut text);
            text
        })
        .collect()
}

fn change_stats(previous: Option<&str>, current: &str) -> (i64, i64, i64) {
    let old = previous.map(snapshot_blocks).unwrap_or_default();
    let new = snapshot_blocks(current);
    let mut old_positions: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut new_positions: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, block) in old.iter().enumerate() {
        old_positions.entry(block).or_default().push(index);
    }
    for (index, block) in new.iter().enumerate() {
        new_positions.entry(block).or_default().push(index);
    }

    let mut changed = 0_i64;
    let mut added = 0_i64;
    let mut removed = 0_i64;
    let mut old_index = 0;
    let mut new_index = 0;
    while old_index < old.len() && new_index < new.len() {
        if old[old_index] == new[new_index] {
            old_index += 1;
            new_index += 1;
            continue;
        }

        let inserted_until = next_position(&new_positions, &old[old_index], new_index + 1);
        let deleted_until = next_position(&old_positions, &new[new_index], old_index + 1);
        let prefer_insert = match (inserted_until, deleted_until) {
            (Some(inserted), Some(deleted)) => inserted - new_index <= deleted - old_index,
            (Some(_), None) => true,
            _ => false,
        };

        if prefer_insert {
            let inserted_until = inserted_until.expect("insert position exists");
            for block in &new[new_index..inserted_until] {
                changed += 1;
                added += block.split_whitespace().count() as i64;
            }
            new_index = inserted_until;
        } else if let Some(deleted_until) = deleted_until {
            for block in &old[old_index..deleted_until] {
                changed += 1;
                removed += block.split_whitespace().count() as i64;
            }
            old_index = deleted_until;
        } else {
            changed += 1;
            added += new[new_index].split_whitespace().count() as i64;
            removed += old[old_index].split_whitespace().count() as i64;
            old_index += 1;
            new_index += 1;
        }
    }
    for block in &old[old_index..] {
        changed += 1;
        removed += block.split_whitespace().count() as i64;
    }
    for block in &new[new_index..] {
        changed += 1;
        added += block.split_whitespace().count() as i64;
    }
    (changed, added, removed)
}

fn next_position(
    positions: &HashMap<&str, Vec<usize>>,
    block: &str,
    from: usize,
) -> Option<usize> {
    let matches = positions.get(block)?;
    let index = matches.partition_point(|position| *position < from);
    matches.get(index).copied()
}

pub async fn snapshot(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
    Json(req): Json<SnapshotRequest>,
) -> Result<Json<Option<DocumentVersionMeta>>, AppError> {
    require_access(&state, doc_id, auth.user_id, true).await?;
    if req.doc_json.is_empty() || req.doc_json.len() > MAX_SNAPSHOT_BYTES {
        return Err(AppError::bad_request(
            "bad_snapshot",
            "snapshot must be 1 byte to 4 MB",
        ));
    }
    if serde_json::from_str::<serde_json::Value>(&req.doc_json).is_err() {
        return Err(AppError::bad_request("bad_snapshot", "not valid JSON"));
    }
    let name = match &req.name {
        Some(n) => {
            let n = n.trim();
            if n.is_empty() || n.len() > 120 {
                return Err(AppError::bad_request(
                    "invalid_name",
                    "version name must be 1-120 characters",
                ));
            }
            Some(n.to_string())
        }
        None => None,
    };
    let kind = req.kind.as_deref().unwrap_or(if name.is_some() { "named" } else { "auto" });
    if !matches!(kind, "auto" | "named" | "draft") || (kind == "draft" && name.is_none()) {
        return Err(AppError::bad_request("invalid_kind", "snapshot kind must be auto, named, or a named draft"));
    }

    let now = now_millis();
    // The latest snapshot always refreshes the excerpt/list preview.
    sqlx::query("UPDATE documents SET content_json = ?, updated_at = ? WHERE id = ?")
        .bind(&req.doc_json)
        .bind(now)
        .bind(doc_id)
        .execute(&state.pool)
        .await?;

    let hash = hex::encode(Sha256::digest(req.doc_json.as_bytes()));
    if kind == "auto" {
        // Auto snapshots: at most one per interval, skip unchanged content.
        let newest: Option<(String, i64)> = sqlx::query_as(
            "SELECT content_hash, created_at FROM document_versions
             WHERE doc_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .bind(doc_id)
        .fetch_optional(&state.pool)
        .await?;
        if let Some((newest_hash, newest_at)) = newest {
            if newest_hash == hash || now - newest_at < AUTO_SNAPSHOT_INTERVAL_MS {
                return Ok(Json(None));
            }
        }
    }

    let previous: Option<(String,)> = sqlx::query_as(
        "SELECT doc_json FROM document_versions WHERE doc_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(doc_id)
    .fetch_optional(&state.pool)
    .await?;
    let (changed_blocks, added_words, removed_words) =
        change_stats(previous.as_ref().map(|(json,)| json.as_str()), &req.doc_json);
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO document_versions
         (doc_id, kind, name, doc_json, content_hash, changed_blocks, added_words, removed_words, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(doc_id)
    .bind(kind)
    .bind(&name)
    .bind(&req.doc_json)
    .bind(&hash)
    .bind(changed_blocks)
    .bind(added_words)
    .bind(removed_words)
    .bind(auth.user_id.0)
    .bind(now)
    .fetch_one(&state.pool)
    .await?;
    let row: VersionRow = sqlx::query_as(&format!("{VERSION_SELECT} WHERE v.id = ?"))
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    let meta = row_to_version(row);
    if kind == "draft" {
        insert_activity(&state, doc_id, auth.user_id, "draft_saved", None, None, name.as_deref(), None).await?;
    }
    state.ws.broadcast(
        &doc_room(doc_id),
        "document.version",
        serde_json::to_value(&meta).expect("serializable"),
    );
    Ok(Json(Some(meta)))
}

pub async fn list_versions(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
) -> Result<Json<Vec<DocumentVersionMeta>>, AppError> {
    require_access(&state, doc_id, auth.user_id, false).await?;
    let rows: Vec<VersionRow> = sqlx::query_as(&format!(
        "{VERSION_SELECT} WHERE v.doc_id = ? ORDER BY v.created_at DESC, v.id DESC"
    ))
    .bind(doc_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows.into_iter().map(row_to_version).collect()))
}

pub async fn get_version(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((doc_id, version_id)): Path<(i64, i64)>,
) -> Result<Json<DocumentVersion>, AppError> {
    require_access(&state, doc_id, auth.user_id, false).await?;
    let row: Option<VersionRow> =
        sqlx::query_as(&format!("{VERSION_SELECT} WHERE v.id = ? AND v.doc_id = ?"))
            .bind(version_id)
            .bind(doc_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some(row) = row else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_version",
            "version not found",
        ));
    };
    let (doc_json,): (String,) =
        sqlx::query_as("SELECT doc_json FROM document_versions WHERE id = ?")
            .bind(version_id)
            .fetch_one(&state.pool)
            .await?;
    Ok(Json(DocumentVersion {
        meta: row_to_version(row),
        doc_json,
    }))
}

const ACTIVITY_SELECT: &str = "SELECT a.id, a.doc_id, a.kind, a.subject_kind,
    a.subject_id, a.subject_name, a.detail, a.created_at,
    u.id, u.username, u.display_name, u.avatar_attachment_id, u.accent_color
    FROM document_activity a JOIN users u ON u.id = a.actor_id";

type ActivityRow = (
    i64, i64, String, Option<String>, Option<i64>, Option<String>, Option<String>, i64,
    i64, String, Option<String>, Option<i64>, Option<String>,
);

fn row_to_activity(row: ActivityRow) -> DocumentActivity {
    let (id, doc_id, kind, subject_kind, subject_id, subject_name, detail, created_at,
        uid, username, display_name, avatar, accent) = row;
    DocumentActivity {
        id,
        doc_id,
        kind,
        actor: perms::user_ref(UserId(uid), username, display_name, avatar, accent),
        subject_kind,
        subject_id,
        subject_name,
        detail,
        created_at,
    }
}

pub async fn list_activity(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
) -> Result<Json<Vec<DocumentActivity>>, AppError> {
    require_access(&state, doc_id, auth.user_id, false).await?;
    let rows: Vec<ActivityRow> = sqlx::query_as(&format!(
        "{ACTIVITY_SELECT} WHERE a.doc_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 250"
    ))
    .bind(doc_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows.into_iter().map(row_to_activity).collect()))
}

// ------------------------------------------------------------------- shares

async fn subject_name(state: &AppState, kind: &str, id: i64) -> Result<String, AppError> {
    let name: Option<(String, Option<String>)> = if kind == "user" {
        sqlx::query_as("SELECT username, display_name FROM users WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?
    } else {
        sqlx::query_as("SELECT name, NULL FROM groups WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?
    };
    Ok(name
        .map(|(n, d)| d.unwrap_or(n))
        .unwrap_or_else(|| "unknown".into()))
}

pub async fn list_shares(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
) -> Result<Json<Vec<DocumentShare>>, AppError> {
    let (_, access) = require_access(&state, doc_id, auth.user_id, false).await?;
    require_owner(access)?;
    let rows: Vec<(String, i64, String, i64)> = sqlx::query_as(
        "SELECT subject_kind, subject_id, access, created_at FROM document_shares
         WHERE doc_id = ? ORDER BY created_at",
    )
    .bind(doc_id)
    .fetch_all(&state.pool)
    .await?;
    let mut shares = Vec::with_capacity(rows.len());
    for (subject_kind, subject_id, access, created_at) in rows {
        let name = subject_name(&state, &subject_kind, subject_id).await?;
        shares.push(DocumentShare {
            doc_id,
            subject_kind,
            subject_id,
            subject_name: name,
            access,
            created_at,
        });
    }
    Ok(Json(shares))
}

pub async fn set_share(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
    Json(req): Json<SetShareRequest>,
) -> Result<Json<DocumentShare>, AppError> {
    let (doc, access) = require_access(&state, doc_id, auth.user_id, false).await?;
    require_owner(access)?;
    if req.access != "read" && req.access != "write" {
        return Err(AppError::bad_request(
            "bad_access",
            "access must be read or write",
        ));
    }
    match req.subject_kind.as_str() {
        "user" => {
            if req.subject_id == auth.user_id.0 {
                return Err(AppError::bad_request(
                    "bad_subject",
                    "cannot share with yourself",
                ));
            }
            let (a, b) = if auth.user_id.0 < req.subject_id {
                (auth.user_id.0, req.subject_id)
            } else {
                (req.subject_id, auth.user_id.0)
            };
            let friends: Option<(i64,)> =
                sqlx::query_as("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?")
                    .bind(a)
                    .bind(b)
                    .fetch_optional(&state.pool)
                    .await?;
            if friends.is_none() {
                return Err(AppError::new(
                    StatusCode::FORBIDDEN,
                    "not_friends",
                    "you can only share documents with friends",
                ));
            }
        }
        "group" => {
            if perms::member_role(&state.pool, GroupId(req.subject_id), auth.user_id)
                .await?
                .is_none()
            {
                return Err(AppError::new(
                    StatusCode::FORBIDDEN,
                    "not_a_member",
                    "you can only share documents with groups you belong to",
                ));
            }
        }
        _ => {
            return Err(AppError::bad_request(
                "bad_subject",
                "subject_kind must be user or group",
            ));
        }
    }

    let previous_access: Option<(String,)> = sqlx::query_as(
        "SELECT access FROM document_shares WHERE doc_id = ? AND subject_kind = ? AND subject_id = ?",
    )
    .bind(doc_id)
    .bind(&req.subject_kind)
    .bind(req.subject_id)
    .fetch_optional(&state.pool)
    .await?;
    let now = now_millis();
    sqlx::query(
        "INSERT INTO document_shares (doc_id, subject_kind, subject_id, access, granted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (doc_id, subject_kind, subject_id)
         DO UPDATE SET access = excluded.access",
    )
    .bind(doc_id)
    .bind(&req.subject_kind)
    .bind(req.subject_id)
    .bind(&req.access)
    .bind(auth.user_id.0)
    .bind(now)
    .execute(&state.pool)
    .await?;

    let owner = fetch_user_ref(&state, auth.user_id).await?;
    if req.subject_kind == "user" {
        state.ws.broadcast(
            &format!("user:{}", req.subject_id),
            "document.listchanged",
            serde_json::json!({
                "reason": "shared",
                "document_id": doc_id,
                "title": doc.title,
                "by": owner,
            }),
        );
    } else {
        state.ws.broadcast(
            &format!("group:{}", req.subject_id),
            "document.listchanged",
            serde_json::json!({
                "reason": "shared",
                "document_id": doc_id,
                "title": doc.title,
                "by": owner,
            }),
        );
        post_share_card(
            &state,
            &doc,
            GroupId(req.subject_id),
            auth.user_id,
            &req.access,
        )
        .await?;
    }

    let name = subject_name(&state, &req.subject_kind, req.subject_id).await?;
    let activity_kind = if previous_access.is_some() { "share_updated" } else { "shared" };
    insert_activity(
        &state,
        doc_id,
        auth.user_id,
        activity_kind,
        Some(&req.subject_kind),
        Some(req.subject_id),
        Some(&name),
        Some(&req.access),
    )
    .await?;
    Ok(Json(DocumentShare {
        doc_id,
        subject_kind: req.subject_kind,
        subject_id: req.subject_id,
        subject_name: name,
        access: req.access,
        created_at: now,
    }))
}

/// Announce a group share as a `document` card message in the group's first
/// text channel, mirroring the session join card.
async fn post_share_card(
    state: &AppState,
    doc: &Document,
    group: GroupId,
    author: UserId,
    access: &str,
) -> Result<(), AppError> {
    let channel: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM channels WHERE group_id = ? AND kind = 'text' ORDER BY position, id LIMIT 1",
    )
    .bind(group.0)
    .fetch_optional(&state.pool)
    .await?;
    let Some((channel_id,)) = channel else {
        return Ok(());
    };
    let now = now_millis();
    let content = serde_json::json!({
        "document_id": doc.id,
        "title": doc.title,
        "access": access,
    })
    .to_string();
    let message_id: i64 = sqlx::query_scalar(
        "INSERT INTO messages (channel_id, author_id, kind, content, created_at)
         VALUES (?, ?, 'document', ?, ?) RETURNING id",
    )
    .bind(channel_id)
    .bind(author.0)
    .bind(&content)
    .bind(now)
    .fetch_one(&state.pool)
    .await?;
    let author_ref = fetch_user_ref(state, author).await?;
    state.ws.broadcast(
        &format!("channel:{channel_id}"),
        "message.created",
        serde_json::to_value(writform_proto::chat::Message {
            id: writform_proto::MessageId(message_id),
            channel_id: writform_proto::ChannelId(channel_id),
            author: author_ref,
            kind: "document".into(),
            content: Some(content),
            reply_to_id: None,
            attachments: vec![],
            created_at: now,
            edited_at: None,
        })
        .expect("serializable"),
    );
    Ok(())
}

pub async fn delete_share(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((doc_id, subject_kind, subject_id)): Path<(i64, String, i64)>,
) -> Result<StatusCode, AppError> {
    let (_, access) = require_access(&state, doc_id, auth.user_id, false).await?;
    require_owner(access)?;
    let name = subject_name(&state, &subject_kind, subject_id).await?;
    sqlx::query(
        "DELETE FROM document_shares WHERE doc_id = ? AND subject_kind = ? AND subject_id = ?",
    )
    .bind(doc_id)
    .bind(&subject_kind)
    .bind(subject_id)
    .execute(&state.pool)
    .await?;
    let room = if subject_kind == "user" {
        format!("user:{subject_id}")
    } else {
        format!("group:{subject_id}")
    };
    state.ws.broadcast(
        &room,
        "document.listchanged",
        serde_json::json!({ "reason": "revoked", "document_id": doc_id }),
    );
    insert_activity(
        &state,
        doc_id,
        auth.user_id,
        "unshared",
        Some(&subject_kind),
        Some(subject_id),
        Some(&name),
        None,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------ threads

const THREAD_SELECT: &str = "SELECT t.id, t.doc_id, t.anchor_b64, t.head_b64, t.excerpt,
    t.resolved, t.created_at, u.id, u.username, u.display_name,
    u.avatar_attachment_id, u.accent_color
    FROM document_threads t JOIN users u ON u.id = t.author_id";

type ThreadRow = (
    i64,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    i64,
    i64,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
);

fn row_to_thread(row: ThreadRow) -> DocumentThread {
    let (
        id,
        doc_id,
        anchor_b64,
        head_b64,
        excerpt,
        resolved,
        created_at,
        uid,
        username,
        display_name,
        avatar,
        accent,
    ) = row;
    DocumentThread {
        id,
        doc_id,
        author: perms::user_ref(UserId(uid), username, display_name, avatar, accent),
        anchor_b64,
        head_b64,
        excerpt,
        resolved: resolved != 0,
        created_at,
        messages: vec![],
    }
}

type ThreadMessageRow = (
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

const THREAD_MESSAGE_SELECT: &str = "SELECT m.id, m.thread_id, m.content, m.created_at,
    u.id, u.username, u.display_name, u.avatar_attachment_id, u.accent_color
    FROM document_thread_messages m JOIN users u ON u.id = m.author_id";

fn row_to_thread_message(row: ThreadMessageRow) -> DocumentThreadMessage {
    let (id, thread_id, content, created_at, uid, username, display_name, avatar, accent) = row;
    DocumentThreadMessage {
        id,
        thread_id,
        author: perms::user_ref(UserId(uid), username, display_name, avatar, accent),
        content,
        created_at,
    }
}

pub async fn list_threads(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
) -> Result<Json<Vec<DocumentThread>>, AppError> {
    require_access(&state, doc_id, auth.user_id, false).await?;
    let rows: Vec<ThreadRow> = sqlx::query_as(&format!(
        "{THREAD_SELECT} WHERE t.doc_id = ? ORDER BY t.created_at, t.id"
    ))
    .bind(doc_id)
    .fetch_all(&state.pool)
    .await?;
    let mut threads: Vec<DocumentThread> = rows.into_iter().map(row_to_thread).collect();
    let msg_rows: Vec<ThreadMessageRow> = sqlx::query_as(&format!(
        "{THREAD_MESSAGE_SELECT}
         WHERE m.thread_id IN (SELECT id FROM document_threads WHERE doc_id = ?)
         ORDER BY m.created_at, m.id"
    ))
    .bind(doc_id)
    .fetch_all(&state.pool)
    .await?;
    let mut by_thread: std::collections::HashMap<i64, Vec<DocumentThreadMessage>> =
        std::collections::HashMap::new();
    for row in msg_rows {
        let msg = row_to_thread_message(row);
        by_thread.entry(msg.thread_id).or_default().push(msg);
    }
    for t in &mut threads {
        t.messages = by_thread.remove(&t.id).unwrap_or_default();
    }
    Ok(Json(threads))
}

pub async fn create_thread(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(doc_id): Path<i64>,
    Json(req): Json<CreateThreadRequest>,
) -> Result<Json<DocumentThread>, AppError> {
    // Feedback needs only read access — commenting isn't editing.
    require_access(&state, doc_id, auth.user_id, false).await?;
    let content = req.content.trim();
    if content.is_empty() || content.len() > MAX_THREAD_CONTENT {
        return Err(AppError::bad_request(
            "invalid_content",
            "feedback must be 1-4000 characters",
        ));
    }
    let excerpt = req.excerpt.as_deref().map(|e| {
        let mut e = e.to_string();
        e.truncate(500);
        e
    });

    let now = now_millis();
    let mut tx = state.pool.begin().await?;
    let thread_id: i64 = sqlx::query_scalar(
        "INSERT INTO document_threads (doc_id, author_id, anchor_b64, head_b64, excerpt, resolved, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?) RETURNING id",
    )
    .bind(doc_id)
    .bind(auth.user_id.0)
    .bind(&req.anchor_b64)
    .bind(&req.head_b64)
    .bind(&excerpt)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO document_thread_messages (thread_id, author_id, content, created_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(thread_id)
    .bind(auth.user_id.0)
    .bind(content)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let thread = fetch_thread(&state, thread_id).await?;
    state.ws.broadcast(
        &doc_room(doc_id),
        "document.thread.created",
        serde_json::to_value(&thread).expect("serializable"),
    );
    Ok(Json(thread))
}

async fn fetch_thread(state: &AppState, thread_id: i64) -> Result<DocumentThread, AppError> {
    let row: Option<ThreadRow> = sqlx::query_as(&format!("{THREAD_SELECT} WHERE t.id = ?"))
        .bind(thread_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some(row) = row else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "no_such_thread",
            "thread not found",
        ));
    };
    let mut thread = row_to_thread(row);
    let msg_rows: Vec<ThreadMessageRow> = sqlx::query_as(&format!(
        "{THREAD_MESSAGE_SELECT} WHERE m.thread_id = ? ORDER BY m.created_at, m.id"
    ))
    .bind(thread_id)
    .fetch_all(&state.pool)
    .await?;
    thread.messages = msg_rows.into_iter().map(row_to_thread_message).collect();
    Ok(thread)
}

pub async fn reply_thread(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(thread_id): Path<i64>,
    Json(req): Json<ReplyThreadRequest>,
) -> Result<Json<DocumentThreadMessage>, AppError> {
    let thread = fetch_thread(&state, thread_id).await?;
    require_access(&state, thread.doc_id, auth.user_id, false).await?;
    let content = req.content.trim();
    if content.is_empty() || content.len() > MAX_THREAD_CONTENT {
        return Err(AppError::bad_request(
            "invalid_content",
            "reply must be 1-4000 characters",
        ));
    }
    let now = now_millis();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO document_thread_messages (thread_id, author_id, content, created_at)
         VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(thread_id)
    .bind(auth.user_id.0)
    .bind(content)
    .bind(now)
    .fetch_one(&state.pool)
    .await?;
    let author = fetch_user_ref(&state, auth.user_id).await?;
    let message = DocumentThreadMessage {
        id,
        thread_id,
        author,
        content: content.to_string(),
        created_at: now,
    };
    state.ws.broadcast(
        &doc_room(thread.doc_id),
        "document.thread.replied",
        serde_json::json!({ "doc_id": thread.doc_id, "message": message }),
    );
    Ok(Json(message))
}

/// Thread author or document owner.
async fn require_thread_control(
    state: &AppState,
    thread: &DocumentThread,
    user: UserId,
) -> Result<(), AppError> {
    if thread.author.id == user {
        return Ok(());
    }
    let (_, access) = require_access(state, thread.doc_id, user, false).await?;
    if access == Access::Owner {
        return Ok(());
    }
    Err(AppError::new(
        StatusCode::FORBIDDEN,
        "not_allowed",
        "only the thread author or document owner may do this",
    ))
}

pub async fn update_thread(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(thread_id): Path<i64>,
    Json(req): Json<UpdateThreadRequest>,
) -> Result<Json<DocumentThread>, AppError> {
    let thread = fetch_thread(&state, thread_id).await?;
    require_access(&state, thread.doc_id, auth.user_id, false).await?;
    require_thread_control(&state, &thread, auth.user_id).await?;
    sqlx::query("UPDATE document_threads SET resolved = ? WHERE id = ?")
        .bind(req.resolved as i64)
        .bind(thread_id)
        .execute(&state.pool)
        .await?;
    let thread = fetch_thread(&state, thread_id).await?;
    state.ws.broadcast(
        &doc_room(thread.doc_id),
        "document.thread.updated",
        serde_json::to_value(&thread).expect("serializable"),
    );
    Ok(Json(thread))
}

pub async fn delete_thread(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(thread_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let thread = fetch_thread(&state, thread_id).await?;
    require_access(&state, thread.doc_id, auth.user_id, false).await?;
    require_thread_control(&state, &thread, auth.user_id).await?;
    sqlx::query("DELETE FROM document_threads WHERE id = ?")
        .bind(thread_id)
        .execute(&state.pool)
        .await?;
    state.ws.broadcast(
        &doc_room(thread.doc_id),
        "document.thread.deleted",
        serde_json::json!({ "doc_id": thread.doc_id, "thread_id": thread_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::change_stats;
    use serde_json::json;

    fn document(lines: &[&str]) -> String {
        json!({
            "type": "doc",
            "content": lines.iter().map(|line| json!({
                "type": "paragraph",
                "attrs": { "element": "action" },
                "content": [{ "type": "text", "text": line }]
            })).collect::<Vec<_>>()
        })
        .to_string()
    }

    #[test]
    fn change_stats_treats_a_middle_insertion_as_one_changed_block() {
        let before = document(&["First line", "Second line", "Third line"]);
        let after = document(&["First line", "A newly inserted line", "Second line", "Third line"]);

        assert_eq!(change_stats(Some(&before), &after), (1, 4, 0));
    }

    #[test]
    fn change_stats_treats_a_middle_deletion_as_one_changed_block() {
        let before = document(&["First line", "Remove this line", "Second line", "Third line"]);
        let after = document(&["First line", "Second line", "Third line"]);

        assert_eq!(change_stats(Some(&before), &after), (1, 0, 3));
    }
}
