-- M4-01 normalized per-ballot choice tallies for SQL-side result aggregation.
-- Kept in sync atomically by castVote. choice_json stays the single authoritative
-- record and ballot_choices is a derived index read by SQL aggregation.
CREATE TABLE IF NOT EXISTS ballot_choices (
  poll_id   TEXT NOT NULL,
  ballot_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  votes     INTEGER NOT NULL DEFAULT 1 CHECK (votes >= 1),
  PRIMARY KEY (poll_id, ballot_id, option_id)
);

CREATE INDEX IF NOT EXISTS idx_ballot_choices_poll ON ballot_choices (poll_id);
