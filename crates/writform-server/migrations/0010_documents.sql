-- Documents: CRDT-edited rich documents with version history, sharing
-- (friends and groups, read/write), and anchored feedback threads
-- (docs/documents-plan.md). Content is a Yjs doc: `ydoc_state` holds the
-- compacted state (update v1 encoding), `document_updates` the recent tail.

CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'Untitled',
    format TEXT NOT NULL DEFAULT 'none', -- none|screenplay|stageplay|manuscript|poetry
    ydoc_state BLOB,                     -- compacted yjs state (update v1); NULL = empty
    state_seq INTEGER NOT NULL DEFAULT 0,-- highest seq merged into ydoc_state
    last_seq INTEGER NOT NULL DEFAULT 0, -- highest appended update seq
    content_json TEXT,                   -- latest TipTap JSON snapshot (list/excerpts)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_documents_owner ON documents(owner_id);

CREATE TABLE document_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    update_data BLOB NOT NULL,           -- yjs update v1, raw bytes
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    UNIQUE (doc_id, seq)
);

CREATE TABLE document_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'auto',   -- auto|named
    name TEXT,
    doc_json TEXT NOT NULL,              -- TipTap JSON
    content_hash TEXT NOT NULL,          -- sha256 hex, dedups auto snapshots
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_document_versions_doc ON document_versions(doc_id, created_at DESC);

CREATE TABLE document_shares (
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    subject_kind TEXT NOT NULL,          -- user|group
    subject_id INTEGER NOT NULL,         -- users.id or groups.id (polymorphic, no FK)
    access TEXT NOT NULL,                -- read|write
    granted_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (doc_id, subject_kind, subject_id)
);
CREATE INDEX idx_document_shares_subject ON document_shares(subject_kind, subject_id);

CREATE TABLE document_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    anchor_b64 TEXT,                     -- yjs relative position; NULL = whole-doc
    head_b64 TEXT,
    excerpt TEXT,                        -- plain-text snapshot of the referenced selection
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_document_threads_doc ON document_threads(doc_id, created_at);

CREATE TABLE document_thread_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES document_threads(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_document_thread_messages_thread
    ON document_thread_messages(thread_id, created_at);
