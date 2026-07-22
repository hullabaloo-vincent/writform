ALTER TABLE users ADD COLUMN banner_attachment_id INTEGER REFERENCES attachments(id);
