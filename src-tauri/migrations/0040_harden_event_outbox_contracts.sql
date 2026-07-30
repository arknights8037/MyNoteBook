ALTER TABLE domain_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1
  CHECK (schema_version = 1);
ALTER TABLE domain_events ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE domain_events ADD COLUMN workspace_id TEXT;
ALTER TABLE domain_events ADD COLUMN deduplication_key TEXT;
ALTER TABLE domain_events ADD COLUMN security_scope_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(security_scope_json));

CREATE UNIQUE INDEX idx_domain_events_source_deduplication
ON domain_events(source, deduplication_key)
WHERE deduplication_key IS NOT NULL;

ALTER TABLE outbox_messages RENAME TO outbox_messages_p4;

CREATE TABLE outbox_messages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'published', 'failed', 'dead_lettered')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_owner TEXT,
  last_error TEXT,
  last_failure_kind TEXT,
  published_at INTEGER,
  dead_lettered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (event_id) REFERENCES domain_events(id) ON DELETE CASCADE
);

INSERT INTO outbox_messages (
  id, event_id, topic, payload_json, status, attempt_count, available_at,
  lease_until, lease_owner, last_error, published_at, created_at, updated_at
)
SELECT
  id, event_id, topic, payload_json, status, attempt_count, available_at,
  lease_until, lease_owner, last_error, published_at, created_at,
  COALESCE(published_at, available_at, created_at)
FROM outbox_messages_p4;

DROP TABLE outbox_messages_p4;

CREATE INDEX idx_outbox_delivery
ON outbox_messages(status, available_at ASC, created_at ASC);

CREATE INDEX idx_outbox_dead_letter
ON outbox_messages(dead_lettered_at DESC)
WHERE status = 'dead_lettered';
