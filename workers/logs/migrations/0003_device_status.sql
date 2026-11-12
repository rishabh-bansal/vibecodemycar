-- Upload health per device: each browser periodically reports its outbox state (counts per kind and status,
-- its newest upload errors, its build), so failures are visible remotely, not only on that browser.
-- One row per device, replaced on every report; removed with its device's retention.

CREATE TABLE device_status (
  device_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  body TEXT NOT NULL
);
