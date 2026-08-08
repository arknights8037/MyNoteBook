CREATE TABLE workflow_work_items (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('manual', 'timer', 'rss', 'related_update')),
  classification TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'active', 'waiting', 'completed', 'failed', 'cancelled')),
  payload_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(payload_json)),
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  deduplication_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (event_id) REFERENCES domain_events(id) ON DELETE RESTRICT
);

CREATE INDEX idx_workflow_work_items_status
ON workflow_work_items(status, created_at ASC);

CREATE TABLE workflow_instances (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL UNIQUE,
  workflow_type TEXT NOT NULL
    CHECK (workflow_type IN ('agent', 'deterministic_action')),
  state TEXT NOT NULL DEFAULT 'READY'
    CHECK (state IN (
      'READY', 'RUNNING', 'WAITING_EVENT', 'WAITING_TIMER', 'WAITING_HUMAN',
      'WAITING_APPROVAL', 'RETRY_SCHEDULED', 'COMPLETED', 'FAILED', 'CANCELLED'
    )),
  current_run_id TEXT,
  current_wait_condition_id TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  output_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (work_item_id) REFERENCES workflow_work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (current_wait_condition_id) REFERENCES workflow_wait_conditions(id) ON DELETE SET NULL
);

CREATE INDEX idx_workflow_instances_state
ON workflow_instances(state, updated_at ASC);

CREATE TABLE workflow_run_attempts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  causation_event_id TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  FOREIGN KEY (workflow_id) REFERENCES workflow_instances(id) ON DELETE CASCADE,
  FOREIGN KEY (causation_event_id) REFERENCES domain_events(id) ON DELETE SET NULL,
  UNIQUE (workflow_id, attempt_number)
);

ALTER TABLE automation_runs ADD COLUMN workflow_work_item_id TEXT
  REFERENCES workflow_work_items(id) ON DELETE SET NULL;
ALTER TABLE automation_runs ADD COLUMN workflow_id TEXT
  REFERENCES workflow_instances(id) ON DELETE SET NULL;

ALTER TABLE signal_agent_runs ADD COLUMN workflow_work_item_id TEXT
  REFERENCES workflow_work_items(id) ON DELETE SET NULL;
ALTER TABLE signal_agent_runs ADD COLUMN workflow_id TEXT
  REFERENCES workflow_instances(id) ON DELETE SET NULL;

CREATE TABLE external_action_requests (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  run_id TEXT,
  action_type TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  approval_id TEXT NOT NULL UNIQUE,
  wait_condition_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN (
      'pending_approval', 'approved', 'executing', 'completed', 'failed',
      'dead_lettered', 'rejected', 'cancelled'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  provider_reference TEXT,
  output_json TEXT,
  error TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  dead_lettered_at INTEGER,
  FOREIGN KEY (workflow_id) REFERENCES workflow_instances(id) ON DELETE CASCADE,
  FOREIGN KEY (work_item_id) REFERENCES workflow_work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (wait_condition_id) REFERENCES workflow_wait_conditions(id) ON DELETE RESTRICT
);

CREATE INDEX idx_external_action_dispatch
ON external_action_requests(status, next_attempt_at, created_at ASC)
WHERE status IN ('approved', 'executing');

CREATE TABLE external_action_approvals (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL UNIQUE,
  decision TEXT NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'approved', 'rejected', 'cancelled')),
  actor_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(details_json)),
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (action_id) REFERENCES external_action_requests(id) ON DELETE CASCADE
);

CREATE TABLE external_action_attempts (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  fencing_token INTEGER NOT NULL,
  lease_owner TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('executing', 'completed', 'failed', 'interrupted')),
  provider_reference TEXT,
  output_json TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (action_id) REFERENCES external_action_requests(id) ON DELETE CASCADE,
  UNIQUE (action_id, attempt_number),
  UNIQUE (action_id, fencing_token)
);
