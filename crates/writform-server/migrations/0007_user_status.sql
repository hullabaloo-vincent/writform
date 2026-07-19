-- Presence status: 'online' | 'busy' | 'hidden'. Hidden users appear
-- offline to everyone (their sockets still work normally).

ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'online';
