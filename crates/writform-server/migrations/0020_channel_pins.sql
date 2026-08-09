-- Pinned messages, one row per pin. message_id is the PK: a message is
-- pinned once, to the channel it lives in. Hard deletes cascade the pin;
-- soft deletes are cleaned up by the delete handler.
CREATE TABLE channel_pins (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    pinned_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_channel_pins_channel ON channel_pins(channel_id);
