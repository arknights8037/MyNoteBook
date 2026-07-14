CREATE TABLE IF NOT EXISTS knowledge_objects (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('decision', 'rule', 'goal', 'task', 'evidence', 'change_set')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'candidate', 'approved', 'active', 'deprecated')),
  title TEXT NOT NULL,
  owner_id TEXT,
  scope_json TEXT NOT NULL DEFAULT '{}',
  document_id TEXT,
  block_id TEXT,
  source_revision INTEGER,
  authority_level TEXT NOT NULL DEFAULT 'local',
  confidence REAL,
  valid_from INTEGER,
  valid_until INTEGER,
  verified_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL,
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK ((document_id IS NULL AND block_id IS NULL) OR document_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_objects_type_status
ON knowledge_objects(object_type, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_objects_document
ON knowledge_objects(document_id, block_id);

CREATE TABLE IF NOT EXISTS knowledge_object_relations (
  id TEXT PRIMARY KEY,
  from_object_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('supersedes', 'conflicts_with', 'supports', 'derives_from', 'relates_to')),
  to_object_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (from_object_id) REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  FOREIGN KEY (to_object_id) REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  UNIQUE (from_object_id, relation_type, to_object_id),
  CHECK (from_object_id <> to_object_id)
);

CREATE TABLE IF NOT EXISTS task_definitions (
  id TEXT PRIMARY KEY,
  definition_type TEXT NOT NULL CHECK (definition_type IN ('manual', 'automation', 'knowledge')),
  name TEXT NOT NULL,
  instruction TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL DEFAULT '{}',
  execution_policy_json TEXT NOT NULL DEFAULT '{}',
  source_knowledge_object_id TEXT,
  automation_id TEXT UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (source_knowledge_object_id) REFERENCES knowledge_objects(id) ON DELETE SET NULL,
  FOREIGN KEY (automation_id) REFERENCES automation_tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_definition_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_input', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled', 'timed_out', 'stale')),
  frozen_input_json TEXT NOT NULL DEFAULT '{}',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  error TEXT,
  context_bundle_id TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (task_definition_id) REFERENCES task_definitions(id) ON DELETE SET NULL,
  FOREIGN KEY (context_bundle_id) REFERENCES context_bundles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_runs_status_queued
ON task_runs(status, queued_at ASC);
CREATE INDEX IF NOT EXISTS idx_task_runs_definition
ON task_runs(task_definition_id, queued_at DESC);

ALTER TABLE automation_tasks ADD COLUMN task_definition_id TEXT;
ALTER TABLE automation_runs ADD COLUMN task_run_id TEXT;
ALTER TABLE agent_tasks ADD COLUMN task_run_id TEXT;

INSERT OR IGNORE INTO task_definitions (
  id, definition_type, name, instruction, acceptance_criteria_json,
  execution_policy_json, automation_id, enabled, version, created_at, updated_at
)
SELECT 'taskdef-automation-' || id, 'automation', name, instruction, '{}', '{}',
       id, enabled, 1, created_at, updated_at
FROM automation_tasks;

UPDATE automation_tasks
SET task_definition_id = 'taskdef-automation-' || id
WHERE task_definition_id IS NULL;

INSERT OR IGNORE INTO task_runs (
  id, task_definition_id, status, frozen_input_json, acceptance_criteria_json,
  output_json, error, correlation_id, causation_id, queued_at, started_at, completed_at
)
SELECT 'taskrun-automation-' || id, 'taskdef-automation-' || automation_id,
       CASE status
         WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running'
         WHEN 'completed' THEN 'completed' WHEN 'cancelled' THEN 'cancelled'
         ELSE 'failed' END,
       input_json, '{}', output_json, error, COALESCE(correlation_id, id), causation_id,
       queued_at, started_at, completed_at
FROM automation_runs;

UPDATE automation_runs
SET task_run_id = 'taskrun-automation-' || id
WHERE task_run_id IS NULL;

INSERT OR IGNORE INTO task_runs (
  id, status, frozen_input_json, acceptance_criteria_json, output_json, error,
  context_bundle_id, correlation_id, causation_id, queued_at, started_at, completed_at
)
SELECT 'taskrun-agent-' || id,
       CASE status
         WHEN 'pending' THEN 'queued' WHEN 'running' THEN 'running'
         WHEN 'waiting_confirmation' THEN 'waiting_approval'
         WHEN 'completed' THEN 'completed' WHEN 'cancelled' THEN 'cancelled'
         ELSE 'failed' END,
       json_object('instruction', user_instruction, 'documentId', document_id), '{}', NULL, error,
       context_bundle_id, COALESCE(correlation_id, id), causation_id, created_at,
       CASE WHEN status = 'pending' THEN NULL ELSE created_at END, completed_at
FROM agent_tasks;

UPDATE agent_tasks
SET task_run_id = 'taskrun-agent-' || id
WHERE task_run_id IS NULL;

CREATE TRIGGER IF NOT EXISTS automation_task_definition_after_insert
AFTER INSERT ON automation_tasks
BEGIN
  INSERT OR IGNORE INTO task_definitions (
    id, definition_type, name, instruction, acceptance_criteria_json,
    execution_policy_json, automation_id, enabled, version, created_at, updated_at
  ) VALUES (
    'taskdef-automation-' || NEW.id, 'automation', NEW.name, NEW.instruction,
    '{}', '{}', NEW.id, NEW.enabled, 1, NEW.created_at, NEW.updated_at
  );
  UPDATE automation_tasks
  SET task_definition_id = 'taskdef-automation-' || NEW.id
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS automation_task_definition_after_update
AFTER UPDATE OF name, instruction, enabled, updated_at ON automation_tasks
WHEN NEW.task_definition_id IS NOT NULL
BEGIN
  UPDATE task_definitions
  SET name = NEW.name, instruction = NEW.instruction, enabled = NEW.enabled,
      version = version + 1, updated_at = NEW.updated_at
  WHERE id = NEW.task_definition_id;
END;

CREATE TRIGGER IF NOT EXISTS automation_task_run_after_insert
AFTER INSERT ON automation_runs
BEGIN
  INSERT OR IGNORE INTO task_runs (
    id, task_definition_id, status, frozen_input_json, acceptance_criteria_json,
    correlation_id, causation_id, queued_at
  ) VALUES (
    'taskrun-automation-' || NEW.id,
    (SELECT task_definition_id FROM automation_tasks WHERE id = NEW.automation_id),
    CASE NEW.status WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running' ELSE 'failed' END,
    NEW.input_json, '{}', COALESCE(NEW.correlation_id, NEW.id), NEW.causation_id, NEW.queued_at
  );
  UPDATE automation_runs SET task_run_id = 'taskrun-automation-' || NEW.id WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS automation_task_run_after_status
AFTER UPDATE OF status, output_json, error, started_at, completed_at ON automation_runs
WHEN NEW.task_run_id IS NOT NULL
BEGIN
  UPDATE task_runs
  SET status = CASE NEW.status
      WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running'
      WHEN 'completed' THEN 'completed' WHEN 'cancelled' THEN 'cancelled'
      ELSE 'failed' END,
      output_json = NEW.output_json, error = NEW.error,
      started_at = NEW.started_at, completed_at = NEW.completed_at
  WHERE id = NEW.task_run_id;
END;

CREATE TRIGGER IF NOT EXISTS agent_task_run_after_insert
AFTER INSERT ON agent_tasks
BEGIN
  INSERT OR IGNORE INTO task_runs (
    id, status, frozen_input_json, acceptance_criteria_json, context_bundle_id,
    correlation_id, causation_id, queued_at, started_at
  ) VALUES (
    'taskrun-agent-' || NEW.id,
    CASE NEW.status WHEN 'pending' THEN 'queued' WHEN 'running' THEN 'running'
      WHEN 'waiting_confirmation' THEN 'waiting_approval' ELSE 'failed' END,
    json_object('instruction', NEW.user_instruction, 'documentId', NEW.document_id), '{}',
    NEW.context_bundle_id, COALESCE(NEW.correlation_id, NEW.id), NEW.causation_id,
    NEW.created_at, CASE WHEN NEW.status = 'pending' THEN NULL ELSE NEW.created_at END
  );
  UPDATE agent_tasks SET task_run_id = 'taskrun-agent-' || NEW.id WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS agent_task_run_after_status
AFTER UPDATE OF status, error, completed_at, context_bundle_id ON agent_tasks
WHEN NEW.task_run_id IS NOT NULL
BEGIN
  UPDATE task_runs
  SET status = CASE NEW.status
      WHEN 'pending' THEN 'queued' WHEN 'running' THEN 'running'
      WHEN 'waiting_confirmation' THEN 'waiting_approval'
      WHEN 'completed' THEN 'completed' WHEN 'cancelled' THEN 'cancelled'
      ELSE 'failed' END,
      error = NEW.error, completed_at = NEW.completed_at,
      context_bundle_id = NEW.context_bundle_id
  WHERE id = NEW.task_run_id;
END;

CREATE TABLE IF NOT EXISTS work_artifacts (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  name TEXT NOT NULL,
  uri TEXT,
  content_json TEXT,
  content_hash TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
  CHECK (uri IS NOT NULL OR content_json IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_work_artifacts_task
ON work_artifacts(task_run_id, created_at ASC);

CREATE TABLE IF NOT EXISTS work_evidence (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unverified', 'valid', 'invalid')),
  document_id TEXT,
  block_id TEXT,
  source_revision INTEGER,
  artifact_id TEXT,
  claim TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL,
  FOREIGN KEY (artifact_id) REFERENCES work_artifacts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_work_evidence_task
ON work_evidence(task_run_id, status, created_at ASC);

CREATE TABLE IF NOT EXISTS result_verifications (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('passed', 'failed', 'needs_approval', 'unverifiable')),
  checks_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  proposed_change_set_id TEXT,
  correlation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_result_verifications_task
ON result_verifications(task_run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS change_sets (
  id TEXT PRIMARY KEY,
  task_run_id TEXT,
  agent_task_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'proposed', 'approved', 'rejected', 'applied', 'rolled_back')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  patch_set_task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_task_id) REFERENCES agent_tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (patch_set_task_id) REFERENCES agent_patch_sets(task_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task_run', 'change_set')),
  entity_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor_id TEXT NOT NULL DEFAULT 'local_user',
  details_json TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (entity_type, entity_id, decision, created_at)
);

INSERT OR IGNORE INTO change_sets (
  id, task_run_id, agent_task_id, status, title, description,
  patch_set_task_id, created_at, updated_at
)
SELECT 'changeset-agent-' || task.id, task.task_run_id, task.id,
       CASE WHEN tx.status = 'rolled_back' THEN 'rolled_back'
            WHEN tx.status = 'applied' THEN 'applied'
            WHEN task.status = 'waiting_confirmation' THEN 'proposed'
            ELSE 'draft' END,
       'Agent 文档修改', task.user_instruction, patch.task_id,
       COALESCE(patch.created_at, task.created_at), COALESCE(task.completed_at, task.created_at)
FROM agent_tasks task
LEFT JOIN agent_patch_sets patch ON patch.task_id = task.id
LEFT JOIN agent_document_transactions tx ON tx.task_id = task.id;

CREATE TRIGGER IF NOT EXISTS change_set_after_patch_set
AFTER INSERT ON agent_patch_sets
BEGIN
  INSERT INTO change_sets (
    id, task_run_id, agent_task_id, status, title, description,
    patch_set_task_id, created_at, updated_at
  )
  SELECT 'changeset-agent-' || task.id, task.task_run_id, task.id, 'proposed',
         'Agent 文档修改', task.user_instruction, NEW.task_id, NEW.created_at, NEW.created_at
  FROM agent_tasks task WHERE task.id = NEW.task_id
  ON CONFLICT(agent_task_id) DO UPDATE SET status = 'proposed',
    patch_set_task_id = excluded.patch_set_task_id, updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS approval_after_agent_confirmation
AFTER INSERT ON agent_confirmations
WHEN NEW.action IN ('applied', 'rejected_set')
BEGIN
  INSERT OR IGNORE INTO approvals (
    id, entity_type, entity_id, decision, actor_id, details_json, correlation_id, created_at
  ) VALUES (
    'approval-agent-confirmation-' || NEW.id, 'change_set', 'changeset-agent-' || NEW.task_id,
    CASE NEW.action WHEN 'applied' THEN 'approved' ELSE 'rejected' END,
    'local_user', NEW.details_json,
    COALESCE((SELECT correlation_id FROM agent_tasks WHERE id = NEW.task_id), NEW.task_id),
    NEW.created_at
  );
  UPDATE change_sets SET status = 'rejected', updated_at = NEW.created_at
  WHERE id = 'changeset-agent-' || NEW.task_id
    AND NEW.action = 'rejected_set' AND status IN ('draft', 'proposed');
END;

CREATE TRIGGER IF NOT EXISTS change_set_after_agent_applied
AFTER INSERT ON agent_confirmations
WHEN NEW.action IN ('applied', 'rolled_back')
BEGIN
  UPDATE change_sets
  SET status = CASE NEW.action WHEN 'applied' THEN 'applied' ELSE 'rolled_back' END,
      updated_at = NEW.created_at
  WHERE id = 'changeset-agent-' || NEW.task_id;
END;

CREATE TABLE IF NOT EXISTS view_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  view_type TEXT NOT NULL CHECK (view_type IN ('query', 'projection')),
  scope_query_json TEXT NOT NULL,
  projection_schema_json TEXT,
  render_spec_json TEXT NOT NULL DEFAULT '{}',
  refresh_policy TEXT NOT NULL DEFAULT 'manual' CHECK (refresh_policy = 'manual'),
  writeback_policy TEXT NOT NULL CHECK (writeback_policy IN ('readonly', 'propose_changeset')),
  target_document_id TEXT,
  stale INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  current_snapshot_id TEXT,
  last_refreshed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (target_document_id) REFERENCES documents(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS view_snapshots (
  id TEXT PRIMARY KEY,
  view_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('fresh', 'stale', 'failed')),
  source_snapshot_hash TEXT NOT NULL,
  render_json TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (view_id) REFERENCES view_definitions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_view_snapshots_view_created
ON view_snapshots(view_id, created_at DESC);

CREATE TABLE IF NOT EXISTS view_dependencies (
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

CREATE TRIGGER IF NOT EXISTS views_stale_after_document_revision
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
  WHERE view_id IN (SELECT id FROM view_definitions WHERE stale = 1);
END;

CREATE TRIGGER IF NOT EXISTS views_stale_after_knowledge_update
AFTER UPDATE OF version, status, updated_at ON knowledge_objects
BEGIN
  UPDATE view_definitions SET stale = 1, updated_at = NEW.updated_at
  WHERE id IN (
    SELECT dependency.view_id FROM view_dependencies dependency
    INNER JOIN view_definitions view ON view.current_snapshot_id = dependency.snapshot_id
    WHERE dependency.knowledge_object_id = NEW.id AND dependency.source_revision <> NEW.version
  );
  UPDATE view_snapshots SET status = 'stale'
  WHERE view_id IN (SELECT id FROM view_definitions WHERE stale = 1);
END;
