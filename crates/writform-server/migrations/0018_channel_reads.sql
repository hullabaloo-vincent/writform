-- Per-user read position per channel, so unread state syncs across devices.
-- The PK covers both lookup directions; unread counting rides the existing
-- messages(channel_id) access paths.
CREATE TABLE channel_reads (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_message_id INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
);
