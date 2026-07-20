-- Per-element text styling (JSON: size/bold/italic/underline/align/list).
ALTER TABLE canvas_elements ADD COLUMN style TEXT NOT NULL DEFAULT '';
