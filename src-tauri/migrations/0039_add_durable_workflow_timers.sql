CREATE TABLE workflow_wait_conditions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  deduplication_key TEXT NOT NULL,
  condition_kind TEXT NOT NULL
    CHECK (condition_kind IN ('timer', 'event', 'human', 'approval')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'satisfied', 'cancelled', 'failed')),
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  resume_payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  satisfied_at INTEGER,
  UNIQUE (workflow_id, deduplication_key)
);

CREATE INDEX idx_workflow_wait_conditions_pending
ON workflow_wait_conditions(workflow_id, condition_kind, created_at ASC)
WHERE status = 'pending';

CREATE TABLE workflow_timers (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  wait_condition_id TEXT NOT NULL UNIQUE,
  due_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'processing', 'fired', 'cancelled', 'dead_lettered')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  fired_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (wait_condition_id) REFERENCES workflow_wait_conditions(id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_timers_due
ON workflow_timers(available_at ASC, due_at ASC, created_at ASC)
WHERE status = 'scheduled';

CREATE INDEX idx_workflow_timers_expired_lease
ON workflow_timers(lease_expires_at ASC)
WHERE status = 'processing';

CREATE INDEX idx_workflow_timers_workflow
ON workflow_timers(workflow_id, created_at DESC);
