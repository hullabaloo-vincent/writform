-- WritForm initial schema. Timestamps are unix milliseconds (INTEGER).

CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    avatar_attachment_id INTEGER REFERENCES attachments(id),
    is_server_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE auth_sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    device_label TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
);

CREATE TABLE group_members (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_group_members_user ON group_members(user_id);

CREATE TABLE invites (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    created_by INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER,
    max_uses INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- Unified channels: group text channels, session side-chats, and DMs all use
-- the same messages stack.
CREATE TABLE channels (
    id INTEGER PRIMARY KEY,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'session', 'dm')),
    name TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_channels_group ON channels(group_id);

CREATE TABLE dm_pairs (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    -- canonical order: user_a < user_b
    user_a INTEGER NOT NULL REFERENCES users(id),
    user_b INTEGER NOT NULL REFERENCES users(id),
    UNIQUE (user_a, user_b),
    CHECK (user_a < user_b)
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    -- 'text' | 'shared_note' | 'system' | 'plugin:<plugin_id>:<type>'
    kind TEXT NOT NULL DEFAULT 'text',
    content TEXT,
    reply_to_id INTEGER REFERENCES messages(id),
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER
);
CREATE INDEX idx_messages_channel ON messages(channel_id, id);

CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    sha256 TEXT NOT NULL,
    mime TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    original_name TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_attachments_sha ON attachments(sha256);

CREATE TABLE message_attachments (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    attachment_id INTEGER NOT NULL REFERENCES attachments(id),
    PRIMARY KEY (message_id, attachment_id)
);

CREATE TABLE emotes (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    attachment_id INTEGER NOT NULL REFERENCES attachments(id),
    UNIQUE (group_id, name)
);

CREATE TABLE friend_requests (
    id INTEGER PRIMARY KEY,
    from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (from_user, to_user)
);

CREATE TABLE friendships (
    -- canonical order: user_a < user_b
    user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
);

-- A session is a container: it holds one or more prompts, each independently
-- started/timed by its creator. Browsing a past session shows every prompt,
-- everyone's final writing, and the side-chat history (no voice is recorded).
CREATE TABLE writing_sessions (
    id INTEGER PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'ended')),
    chat_channel_id INTEGER REFERENCES channels(id),
    created_at INTEGER NOT NULL,
    ended_at INTEGER
);
CREATE INDEX idx_sessions_channel ON writing_sessions(channel_id);
CREATE INDEX idx_sessions_state ON writing_sessions(state);

CREATE TABLE session_prompts (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES writing_sessions(id) ON DELETE CASCADE,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    position INTEGER NOT NULL DEFAULT 0,
    prompt_doc TEXT NOT NULL,               -- TipTap JSON
    timer_seconds INTEGER,
    state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'running', 'ended')),
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ends_at INTEGER,
    ended_at INTEGER
);
CREATE INDEX idx_prompts_session ON session_prompts(session_id, position);
CREATE INDEX idx_prompts_state ON session_prompts(state);

CREATE TABLE session_submissions (
    id INTEGER PRIMARY KEY,
    prompt_id INTEGER NOT NULL REFERENCES session_prompts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    doc TEXT NOT NULL,                      -- TipTap JSON
    updated_at INTEGER NOT NULL,
    submitted_at INTEGER,
    UNIQUE (prompt_id, user_id)
);

CREATE TABLE submission_snapshots (
    id INTEGER PRIMARY KEY,
    submission_id INTEGER NOT NULL REFERENCES session_submissions(id) ON DELETE CASCADE,
    doc TEXT NOT NULL,
    captured_at INTEGER NOT NULL
);
CREATE INDEX idx_snapshots_submission ON submission_snapshots(submission_id, captured_at);

CREATE TABLE shared_notes (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    recipient_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    content_md TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Generic scoped storage for client-side plugins (server stays plugin-free).
CREATE TABLE plugin_data (
    plugin_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('user', 'group', 'channel')),
    scope_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, scope, scope_id, key)
);
