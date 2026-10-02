-- M4-02 site_stats table (does not reference any poll).
-- One row per heartbeat records anonymous site traffic for the dashboard.
CREATE TABLE IF NOT EXISTS site_stats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  page        TEXT NOT NULL,
  visitorId   TEXT NOT NULL,
  duration    INTEGER,
  device      TEXT,
  referrer    TEXT,
  ip          TEXT,
  createdAt   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_site_stats_created_at ON site_stats (createdAt);
