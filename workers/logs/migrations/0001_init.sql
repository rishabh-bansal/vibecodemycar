-- OBDCraft private logs. Retention: items 180 days after their last update; enrollment attempts 1 day;
-- devices unused for 180 days are revoked. Enforced by the Worker's daily scheduled run.

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 of the device token; the token itself is never stored
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE enroll_attempts (
  ip TEXT NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX enroll_attempts_ip_at ON enroll_attempts (ip, at);

CREATE TABLE items (
  kind TEXT NOT NULL CHECK (kind IN ('experiment', 'journal')),
  id TEXT NOT NULL,
  schema TEXT NOT NULL,
  build_id TEXT NOT NULL,
  recipe_id TEXT,
  recipe_digest TEXT,
  operation TEXT NOT NULL,
  mode TEXT NOT NULL,
  outcome TEXT,
  ack TEXT,                              -- the payload's acknowledgement only
  sequence_complete INTEGER,             -- 1 / 0 / NULL: a declared sequence completed after the payload
  physical TEXT,                         -- the owner's latest physical observation verdict
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX items_updated_at ON items (updated_at);
