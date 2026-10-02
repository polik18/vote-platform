-- M4-02: enrich poll_result_snapshots with counts, json blobs, frozen rules,
-- and a content_hash for tamper-evidence. All columns are additive. Prior rows
-- stay valid. The content_hash is computed at close time from the snapshot's
-- own fields and verified on every read (GET /api/polls/:id/results).
-- Note: node:sqlite does not support multi-column ALTER TABLE ADD, so each
-- column is added in its own statement.
ALTER TABLE poll_result_snapshots ADD COLUMN participant_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE poll_result_snapshots ADD COLUMN total_votes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE poll_result_snapshots ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE poll_result_snapshots ADD COLUMN rules_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE poll_result_snapshots ADD COLUMN content_hash TEXT;
