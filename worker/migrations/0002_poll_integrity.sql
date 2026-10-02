-- M1: poll integrity tracking + version locking
-- Adds version tracking, freeze timestamps, transition log, rule locks, and close snapshot.

-- 1. Add integrity columns to polls (status already holds the state machine value)
ALTER TABLE polls ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE polls ADD COLUMN first_vote_at TEXT;
ALTER TABLE polls ADD COLUMN options_frozen_at TEXT;
ALTER TABLE polls ADD COLUMN closed_at TEXT;
ALTER TABLE polls ADD COLUMN archived_at TEXT;

-- 2. Transition log: who changed what, when (immutable audit trail).
CREATE TABLE IF NOT EXISTS poll_state_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    by_uid TEXT,
    by_email TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_poll_state_transitions_poll ON poll_state_transitions(poll_id);

-- 3. Version lock table: once the first vote arrives, core rules cannot change.
--    rule_snapshot captures the frozen rule set + options at that moment.
CREATE TABLE IF NOT EXISTS poll_version_locks (
    poll_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    rule_snapshot TEXT NOT NULL,
    locked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 4. Snapshot table: closed results frozen at close time (immutable).
CREATE TABLE IF NOT EXISTS poll_result_snapshots (
    poll_id TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
