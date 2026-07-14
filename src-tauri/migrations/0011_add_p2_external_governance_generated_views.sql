DROP TRIGGER IF EXISTS views_stale_after_document_revision;
DROP TRIGGER IF EXISTS views_stale_after_knowledge_update;

ALTER TABLE view_dependencies RENAME TO view_dependencies_p1;
ALTER TABLE view_snapshots RENAME TO view_snapshots_p1;
ALTER TABLE view_definitions RENAME TO view_definitions_p1;
DROP INDEX IF EXISTS idx_view_snapshots_view_created;

CREATE TABLE view_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  view_type TEXT NOT NULL CHECK (view_type IN ('query', 'projection', 'generated')),
  scope_query_json TEXT NOT NULL,
  projection_schema_json TEXT,
  render_spec_json TEXT NOT NULL DEFAULT '{}',
  refresh_policy TEXT NOT NULL DEFAULT 'manual' CHECK (refresh_policy = 'manual'),
  writeback_policy TEXT NOT NULL CHECK (writeback_policy IN ('readonly', 'propose_changeset', 'fork_document')),
  target_document_id TEXT,
  generation_prompt TEXT,
  generation_provider TEXT,
  generation_model TEXT,
  generation_skill_versions_json TEXT NOT NULL DEFAULT '[]',
  manual_override INTEGER NOT NULL DEFAULT 0,
  override_content_json TEXT,
  override_updated_at INTEGER,
  stale INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  current_snapshot_id TEXT,
  last_refreshed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (target_document_id) REFERENCES documents(id) ON DELETE SET NULL,
  CHECK (view_type <> 'generated' OR (generation_prompt IS NOT NULL AND generation_provider IS NOT NULL AND generation_model IS NOT NULL)),
  CHECK (manual_override = 0 OR override_content_json IS NOT NULL)
);

INSERT INTO view_definitions (
  id, name, view_type, scope_query_json, projection_schema_json, render_spec_json,
  refresh_policy, writeback_policy, target_document_id, stale, version,
  current_snapshot_id, last_refreshed_at, created_at, updated_at
)
SELECT id, name, view_type, scope_query_json, projection_schema_json, render_spec_json,
       refresh_policy, writeback_policy, target_document_id, stale, version,
       current_snapshot_id, last_refreshed_at, created_at, updated_at
FROM view_definitions_p1;

CREATE TABLE view_snapshots (
  id TEXT PRIMARY KEY,
  view_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('fresh', 'stale', 'failed', 'preview')),
  source_snapshot_hash TEXT NOT NULL,
  render_json TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  skill_versions_json TEXT NOT NULL DEFAULT '[]',
  generated_at INTEGER,
  protected_by_override INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT,
  causation_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (view_id) REFERENCES view_definitions(id) ON DELETE CASCADE
);

INSERT INTO view_snapshots (
  id, view_id, status, source_snapshot_hash, render_json, error, created_at
)
SELECT id, view_id, status, source_snapshot_hash, render_json, error, created_at
FROM view_snapshots_p1;

CREATE INDEX idx_view_snapshots_view_created
ON view_snapshots(view_id, created_at DESC);

CREATE TABLE view_dependencies (
  snapshot_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('knowledge_object', 'document_block')),
  knowledge_object_id TEXT,
  document_id TEXT,
  block_id TEXT,
  source_revision INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, source_type, knowledge_object_id, document_id, block_id),
  FOREIGN KEY (snapshot_id) REFERENCES view_snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY (view_id) REFERENCES view_definitions(id) ON DELETE CASCADE,
  FOREIGN KEY (knowledge_object_id) REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

INSERT INTO view_dependencies
SELECT snapshot_id, view_id, source_type, knowledge_object_id, document_id, block_id, source_revision
FROM view_dependencies_p1;

DROP TABLE view_dependencies_p1;
DROP TABLE view_snapshots_p1;
DROP TABLE view_definitions_p1;

CREATE TRIGGER views_stale_after_document_revision
AFTER UPDATE OF revision ON documents
WHEN NEW.revision <> OLD.revision
BEGIN
  UPDATE view_definitions SET stale = 1, updated_at = NEW.updated_at
  WHERE id IN (
    SELECT dependency.view_id FROM view_dependencies dependency
    INNER JOIN view_definitions view ON view.current_snapshot_id = dependency.snapshot_id
    WHERE dependency.document_id = NEW.id AND dependency.source_revision <> NEW.revision
  );
  UPDATE view_snapshots SET status = 'stale'
  WHERE id IN (SELECT current_snapshot_id FROM view_definitions WHERE stale = 1);
END;

CREATE TRIGGER views_stale_after_knowledge_update
AFTER UPDATE OF version, status, updated_at ON knowledge_objects
BEGIN
  UPDATE view_definitions SET stale = 1, updated_at = NEW.updated_at
  WHERE id IN (
    SELECT dependency.view_id FROM view_dependencies dependency
    INNER JOIN view_definitions view ON view.current_snapshot_id = dependency.snapshot_id
    WHERE dependency.knowledge_object_id = NEW.id AND dependency.source_revision <> NEW.version
  );
  UPDATE view_snapshots SET status = 'stale'
  WHERE id IN (SELECT current_snapshot_id FROM view_definitions WHERE stale = 1);
END;

CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  delegate_type TEXT NOT NULL CHECK (delegate_type IN ('mcp', 'cli')),
  external_actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'running', 'submitted', 'completed', 'failed', 'cancelled', 'expired')),
  context_bundle_id TEXT,
  capability_token_hash TEXT NOT NULL UNIQUE,
  allowed_operations_json TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (context_bundle_id) REFERENCES context_bundles(id) ON DELETE SET NULL
);

CREATE INDEX idx_delegations_task_status
ON delegations(task_run_id, status, created_at DESC);

CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE domain_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX idx_domain_events_aggregate
ON domain_events(aggregate_type, aggregate_id, occurred_at ASC);

CREATE TABLE outbox_messages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'published', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_owner TEXT,
  last_error TEXT,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (event_id) REFERENCES domain_events(id) ON DELETE CASCADE
);

CREATE INDEX idx_outbox_delivery
ON outbox_messages(status, available_at ASC, created_at ASC);

CREATE TABLE external_submissions (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL,
  submission_type TEXT NOT NULL CHECK (submission_type IN ('artifact', 'evidence', 'result', 'change_set')),
  entity_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (delegation_id) REFERENCES delegations(id) ON DELETE CASCADE,
  UNIQUE (delegation_id, idempotency_key)
);
