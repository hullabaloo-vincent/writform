-- Voting on the pieces written for a prompt (a sprint battle). Once a
-- prompt has ended, anyone who can read its session may vote for one piece
-- that isn't their own, and change or take back that vote until voting is
-- closed. Who voted for which piece is never told: people see how many have
-- voted, and the count for each piece once voting has closed.
--
-- voting_closed_at: when the prompt's starter, the session's creator or a
--   group admin closed voting (unix ms). NULL while it is open.

ALTER TABLE session_prompts ADD COLUMN voting_closed_at INTEGER;

CREATE TABLE prompt_votes (
    prompt_id INTEGER NOT NULL REFERENCES session_prompts(id) ON DELETE CASCADE,
    voter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    submission_id INTEGER NOT NULL REFERENCES session_submissions(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (prompt_id, voter_id)
);

CREATE INDEX idx_prompt_votes_submission ON prompt_votes (submission_id);
