-- Canvas / storyboard boards (docs/canvas-plan.md).

CREATE TABLE canvas_boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_canvas_boards_group ON canvas_boards(group_id);

-- Elements are server-authoritative rows, updated last-write-wins.
-- kind: sticky | text | frame | connector
CREATE TABLE canvas_elements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES canvas_boards(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    w REAL NOT NULL DEFAULT 0,
    h REAL NOT NULL DEFAULT 0,
    z INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    from_id INTEGER REFERENCES canvas_elements(id) ON DELETE CASCADE,
    to_id INTEGER REFERENCES canvas_elements(id) ON DELETE CASCADE,
    updated_by INTEGER NOT NULL REFERENCES users(id),
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_canvas_elements_board ON canvas_elements(board_id);
