-- Board background. A JSON blob owned by the client (background color, image
-- attachment id, and how the image is fitted); empty string means the default
-- board surface. Kept as one column for the same reason element styling is:
-- the vocabulary grows without a migration each time.
ALTER TABLE canvas_boards ADD COLUMN style TEXT NOT NULL DEFAULT '';
