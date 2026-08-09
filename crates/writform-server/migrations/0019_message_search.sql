-- Full-text search over prose messages. External-content FTS5: the index
-- mirrors messages.content and must be kept in step by triggers — including
-- soft deletes, which are UPDATEs that null the content, and the real DELETEs
-- that channel/group cascades fire.
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

-- Backfill what already exists. Only 'text' messages hold prose; other kinds
-- carry JSON payloads (join cards, shared notes) that would pollute results.
INSERT INTO messages_fts(rowid, content)
    SELECT id, content FROM messages
    WHERE kind = 'text' AND content IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages
WHEN new.kind = 'text' AND new.content IS NOT NULL
BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Covers edits AND soft deletes (deleted_at set, content nulled): the old
-- text leaves the index, the new text enters only while the row is live.
CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages
WHEN old.kind = 'text'
BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
        SELECT 'delete', old.id, old.content WHERE old.content IS NOT NULL;
    INSERT INTO messages_fts(rowid, content)
        SELECT new.id, new.content
        WHERE new.content IS NOT NULL AND new.deleted_at IS NULL;
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages
WHEN old.kind = 'text' AND old.content IS NOT NULL
BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
END;
