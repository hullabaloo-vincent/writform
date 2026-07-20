-- Change-oriented document history and a human-readable activity timeline.
ALTER TABLE document_versions ADD COLUMN changed_blocks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_versions ADD COLUMN added_words INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_versions ADD COLUMN removed_words INTEGER NOT NULL DEFAULT 0;

CREATE TABLE document_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                  -- opened|shared|share_updated|unshared|draft_saved|restored
    actor_id INTEGER NOT NULL REFERENCES users(id),
    subject_kind TEXT,
    subject_id INTEGER,
    subject_name TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_document_activity_doc ON document_activity(doc_id, created_at DESC);
