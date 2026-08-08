-- Pages within a board. Elements carry the page they sit on; the page's name
-- and order live in the board's own style JSON, so adding or renaming one
-- never needs a migration. Everything that already exists is page 0.
ALTER TABLE canvas_elements ADD COLUMN page INTEGER NOT NULL DEFAULT 0;
