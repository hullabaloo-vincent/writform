-- The newest document vocabulary (node types, marks, attributes) a document's
-- content uses. Level 1 is everything shipped through 1.0.6. Clients older
-- than a document's level are refused: their editor binding would delete
-- what it doesn't recognise, for every collaborator.
ALTER TABLE documents ADD COLUMN schema_level INTEGER NOT NULL DEFAULT 1;
