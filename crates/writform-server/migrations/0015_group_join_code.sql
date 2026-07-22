ALTER TABLE groups ADD COLUMN join_code TEXT;
CREATE UNIQUE INDEX idx_groups_join_code ON groups(join_code) WHERE join_code IS NOT NULL;
