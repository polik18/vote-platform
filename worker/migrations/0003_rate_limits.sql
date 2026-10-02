-- M3-04 fixed-window rate limiting (does not replace participation unique constraint)
-- One row per key holds the count of requests in the current window.
CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    window_start_ms INTEGER NOT NULL
);
