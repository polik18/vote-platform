-- M4-04: idempotency cache for POST /api/polls/:id/vote.
--
-- The participation table's PRIMARY KEY (poll_id, uid) already prevents a user
-- from being double-counted. This table lets a client retry a vote that was
-- lost to a network blip (or double-clicked) with the same client-generated
-- idempotency key and get the original result back instead of 409 already_voted
-- or a second counted ballot.
--
-- Rows are short-lived: they are pruned by pruneIdempotencyKeys() once a vote
-- has been superseded (allow_change) or the poll is closed/archived.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  poll_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  key TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (poll_id, uid, key),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_idempotency_poll ON idempotency_keys(poll_id);
