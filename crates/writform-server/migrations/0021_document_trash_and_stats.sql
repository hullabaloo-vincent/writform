-- Recently Deleted, real search, and list details for documents.
--
-- deleted_at: a document moved to Recently Deleted (unix ms). Every live
--   read filters `deleted_at IS NULL`; the owner can restore it for 30 days,
--   after which a maintenance task deletes it for good.
-- search_text / word_count / excerpt: the latest snapshot's plain text, its
--   word count and opening words. Computed when a snapshot is saved (and
--   backfilled at startup), so search matches words, not editor JSON keys.

ALTER TABLE documents ADD COLUMN deleted_at INTEGER;
ALTER TABLE documents ADD COLUMN search_text TEXT;
ALTER TABLE documents ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN excerpt TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_documents_trash ON documents (owner_id, deleted_at) WHERE deleted_at IS NOT NULL;
