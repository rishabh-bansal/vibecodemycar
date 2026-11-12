-- Automatic logging. Every browser registers itself as an upload-only "collector": it may add and update its
-- OWN items and nothing else. Owner devices (enrolled with the owner code) can read, export and delete.
-- A third kind of item, "session": the full adapter command log of one connection.

ALTER TABLE devices ADD COLUMN role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'collector'));

CREATE TABLE registrations (
  ip TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX registrations_ip_at ON registrations (ip, at);

-- SQLite cannot change a CHECK constraint in place: rebuild items with the new kind.
CREATE TABLE items_v2 (
  kind TEXT NOT NULL CHECK (kind IN ('experiment', 'journal', 'session')),
  id TEXT NOT NULL,
  schema TEXT NOT NULL,
  build_id TEXT NOT NULL,
  recipe_id TEXT,
  recipe_digest TEXT,
  operation TEXT NOT NULL,
  mode TEXT NOT NULL,
  outcome TEXT,
  ack TEXT,
  sequence_complete INTEGER,
  physical TEXT,
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
INSERT INTO items_v2 SELECT * FROM items;
DROP TABLE items;
ALTER TABLE items_v2 RENAME TO items;
CREATE INDEX items_updated_at ON items (updated_at);
CREATE INDEX items_device_received ON items (device_id, received_at);
