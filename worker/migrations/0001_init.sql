PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  owner_email TEXT NOT NULL COLLATE NOCASE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  anonymity TEXT NOT NULL CHECK (anonymity IN ('named','anonymous')),
  vote_mode TEXT NOT NULL CHECK (vote_mode IN ('single','multiple','allocate')),
  max_votes INTEGER NOT NULL DEFAULT 1 CHECK (max_votes >= 1 AND max_votes <= 100),
  require_all_votes INTEGER NOT NULL DEFAULT 0 CHECK (require_all_votes IN (0,1)),
  allow_change INTEGER NOT NULL DEFAULT 0 CHECK (allow_change IN (0,1)),
  eligibility_mode TEXT NOT NULL CHECK (eligibility_mode IN ('public','whitelist','domain')),
  allowed_domain TEXT,
  results_visibility TEXT NOT NULL DEFAULT 'after_close' CHECK (results_visibility IN ('public','after_vote','after_close','admin_only')),
  show_percentages INTEGER NOT NULL DEFAULT 1 CHECK (show_percentages IN (0,1)),
  show_ranking INTEGER NOT NULL DEFAULT 1 CHECK (show_ranking IN (0,1)),
  quorum_type TEXT NOT NULL DEFAULT 'none' CHECK (quorum_type IN ('none','count','percent')),
  quorum_value REAL,
  approval_type TEXT NOT NULL DEFAULT 'none' CHECK (approval_type IN ('none','gt50','gte50','two_thirds','percent','count')),
  approval_value REAL,
  start_at TEXT,
  end_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','open','paused','closed','archived')),
  has_votes INTEGER NOT NULL DEFAULT 0 CHECK (has_votes IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_polls_owner ON polls(owner_uid);
CREATE INDEX IF NOT EXISTS idx_polls_status ON polls(status);

CREATE TABLE IF NOT EXISTS options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
  UNIQUE (poll_id, code)
);

CREATE INDEX IF NOT EXISTS idx_options_poll ON options(poll_id, sort_order);

CREATE TABLE IF NOT EXISTS whitelist (
  poll_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (poll_id, email),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_whitelist_poll ON whitelist(poll_id);

CREATE TABLE IF NOT EXISTS participation (
  poll_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT,
  vote_count INTEGER NOT NULL DEFAULT 0,
  ballot_id TEXT,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (poll_id, uid),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_participation_poll ON participation(poll_id);
CREATE INDEX IF NOT EXISTS idx_participation_email ON participation(poll_id, email);

CREATE TABLE IF NOT EXISTS ballots (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL,
  voter_uid TEXT,
  voter_email TEXT COLLATE NOCASE,
  voter_name TEXT,
  is_named INTEGER NOT NULL DEFAULT 0 CHECK (is_named IN (0,1)),
  choice_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ballots_poll ON ballots(poll_id);
CREATE INDEX IF NOT EXISTS idx_ballots_named_voter ON ballots(poll_id, voter_uid) WHERE is_named = 1;

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id TEXT,
  actor_uid TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_poll ON audit_logs(poll_id, created_at DESC);
