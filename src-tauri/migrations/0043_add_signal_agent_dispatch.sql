CREATE TABLE signal_agent_runs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  frozen_input_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(frozen_input_json)),
  output_json TEXT,
  error TEXT,
  run_id TEXT UNIQUE,
  agent_task_id TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  dead_lettered_at INTEGER,
  last_failure_kind TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (event_id) REFERENCES domain_events(id) ON DELETE CASCADE
);

CREATE INDEX idx_signal_agent_runs_queue
ON signal_agent_runs(status, next_attempt_at, queued_at)
WHERE status IN ('queued', 'running');

CREATE INDEX idx_signal_agent_runs_lease
ON signal_agent_runs(status, lease_expires_at)
WHERE status = 'running';

CREATE TABLE signal_action_receipts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('todo_upsert', 'calendar_upsert')),
  target_id TEXT NOT NULL,
  arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  agent_run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (event_id) REFERENCES domain_events(id) ON DELETE CASCADE,
  UNIQUE(event_id, action_key)
);

CREATE INDEX idx_signal_action_receipts_event
ON signal_action_receipts(event_id, created_at ASC);
