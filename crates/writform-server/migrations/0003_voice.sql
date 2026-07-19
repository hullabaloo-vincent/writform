-- Voice channels: audio rooms per group. Membership/presence is in-memory
-- (it dies with the connection); only the room definitions persist.

CREATE TABLE voice_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_voice_channels_group ON voice_channels(group_id);
