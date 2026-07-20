-- Personal folders for organizing one's own documents, and admin-issued
-- one-time password reset codes (no email on a self-hosted server — the
-- admin hands the code to the user out of band).

CREATE TABLE document_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_document_folders_owner ON document_folders(owner_id);

ALTER TABLE documents ADD COLUMN folder_id INTEGER REFERENCES document_folders(id) ON DELETE SET NULL;

CREATE TABLE password_resets (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,             -- sha256 hex of the one-time code
    expires_at INTEGER NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
);
