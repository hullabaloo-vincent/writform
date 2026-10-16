//! Collaborative documents: Yjs CRDT content synced through
//! `POST /documents/{id}/updates` + the `document:{id}` room, TipTap JSON
//! version snapshots, read/write shares (friends and groups), and anchored
//! feedback threads (docs/documents-plan.md).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::chat::UserRef;
use crate::UnixMillis;

/// The newest document schema level this build understands.
///
/// A document's level names the vocabulary (node types, marks, attributes)
/// its content uses; level 1 is everything shipped through 1.0.6. An editor
/// bound to content newer than its own schema deletes what it doesn't know —
/// for every collaborator — so clients below a document's level are refused
/// (`client_too_old`), and a server never stores a document above the level
/// its own web client understands.
///
/// Level 2 (shipped in 1.1.0): formatting on a run of text (font, size,
/// colour, highlight, sub/superscript), paragraph indents, borders and
/// shading, checklists, tables, footnotes, contents, sections, tracked
/// changes.
///
/// Level 3 (shipped in 1.1.2): a table cell's own borders, a picture's
/// outline and rounded corners.
///
/// Level 4: a chapter's own art on its heading.
///
/// The tables are `editor/schema/levels.ts` in the client; this constant
/// moves with them.
pub const MAX_DOC_SCHEMA_LEVEL: u32 = 4;

fn level_one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Document {
    #[ts(type = "number")]
    pub id: i64,
    pub owner: UserRef,
    pub title: String,
    /// `none` | `screenplay` | `stageplay` | `manuscript` | `poetry`.
    pub format: String,
    /// The owner's folder this document sits in (personal organization).
    #[serde(default)]
    #[ts(type = "number | null")]
    pub folder_id: Option<i64>,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
    #[ts(type = "number")]
    pub updated_at: UnixMillis,
    /// See [`MAX_DOC_SCHEMA_LEVEL`]. Absent from older servers (level 1).
    #[serde(default = "level_one")]
    pub schema_level: u32,
}

/// What this server's documents support (`GET /document-capabilities`;
/// servers without the route are level 1).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentCapabilities {
    pub max_schema_level: u32,
}

/// A personal folder for organizing one's own documents (flat, per-user).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentFolder {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    #[ts(type = "number")]
    pub document_count: i64,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateFolderRequest {
    pub name: String,
}

/// Move a document into a folder (`null` = out of any folder).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MoveDocumentRequest {
    #[ts(type = "number | null")]
    pub folder_id: Option<i64>,
}

/// List entry: a document plus the caller's access to it, with what the
/// organizer shows on its card. The extra fields default for servers that
/// predate them (word count 0, no excerpt).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentListItem {
    pub document: Document,
    /// `owner` | `write` | `read`.
    pub my_access: String,
    /// Words in the latest snapshot.
    #[serde(default)]
    #[ts(type = "number")]
    pub word_count: i64,
    /// The opening words of the text (empty until a snapshot exists).
    #[serde(default)]
    pub excerpt: String,
    /// For a search: the text around the first match.
    #[serde(default)]
    pub snippet: Option<String>,
    /// In Recently Deleted since (only in the trash listing).
    #[serde(default)]
    #[ts(type = "number | null")]
    pub deleted_at: Option<UnixMillis>,
    /// Synopsis, cover and tags (empty from servers that predate them).
    #[serde(default)]
    pub card: DocumentCard,
}

/// What a document's card shows beside its title and words. An editor of
/// the document writes it from the document's own settings (the book's
/// description and cover, a document's subject and keywords).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentCard {
    /// The book's description, cut to 600 characters.
    #[serde(default)]
    pub synopsis: String,
    /// `front <w>x<h> <address>`, or `wrap <w>x<h> <address>` for a whole
    /// cover of which the card shows the right-hand part.
    #[serde(default)]
    pub cover: Option<String>,
    /// Up to 12 tags of up to 40 characters.
    #[serde(default)]
    pub tags: Vec<String>,
}

/// `PUT /documents/{id}/card` (write access). `media` lists every server
/// picture the document's settings name (`writform-att://attachment/N`), so
/// the people it is shared with may read them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SetDocumentCardRequest {
    pub card: DocumentCard,
    #[serde(default)]
    pub media: Vec<String>,
}

/// `document.card`: a document's card changed (to its owner and everyone it
/// is shared with).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DocumentCardChanged {
    #[ts(type = "number")]
    pub document_id: i64,
    pub card: DocumentCard,
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
    /// The level of the content about to be seeded (imports, copies).
    #[serde(default)]
    pub schema_level: Option<u32>,
}

/// Partial update of document metadata (write access required).
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateDocumentRequest {
    pub title: Option<String>,
    pub format: Option<String>,
}

/// One merged batch of local Yjs edits (update v1, base64). Clients batch to
/// ≤ 192 KiB; the server accepts up to 4 MiB (413 `update_too_large` above).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AppendUpdateRequest {
    pub update_b64: String,
    /// The level this update's content needs, when above the document's:
    /// accepting the update raises the document in the same step.
    #[serde(default)]
    pub schema_level: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AppendUpdateResponse {
    #[ts(type = "number")]
    pub seq: i64,
    /// The document's level after this update.
    #[serde(default = "level_one")]
    pub schema_level: u32,
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
