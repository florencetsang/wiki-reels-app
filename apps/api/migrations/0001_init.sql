-- Anonymous users; account linking adds rows to `accounts` later.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

-- Append-only engagement log: source of truth for co-engagement, tuning and ranker training.
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  bucket          INTEGER NOT NULL,
  catalog_version TEXT NOT NULL,
  pageid          INTEGER NOT NULL,
  field           TEXT,
  ts              INTEGER NOT NULL,
  reward          REAL NOT NULL,
  effective       REAL NOT NULL,
  explicit        INTEGER NOT NULL,
  pages_seen      INTEGER NOT NULL,
  n_pages         INTEGER NOT NULL,
  dwell_ms        INTEGER NOT NULL,
  liked           INTEGER NOT NULL,
  saved           INTEGER NOT NULL,
  not_interested  INTEGER NOT NULL,
  less_topic      INTEGER NOT NULL,
  mode            TEXT NOT NULL,
  position        INTEGER NOT NULL,
  reason          TEXT,
  prob            REAL,
  explore         INTEGER
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS events_user ON events (user_id, ts);
