-- Visual customization (2/3): group icon.

ALTER TABLE groups ADD COLUMN icon_attachment_id INTEGER REFERENCES attachments(id);
