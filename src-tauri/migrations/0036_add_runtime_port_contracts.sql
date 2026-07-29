ALTER TABLE agent_tasks ADD COLUMN run_id TEXT;
ALTER TABLE agent_tasks ADD COLUMN workflow_id TEXT;

UPDATE agent_tasks
SET run_id = 'legacy-run-' || id
WHERE run_id IS NULL OR trim(run_id) = '';

CREATE UNIQUE INDEX idx_agent_tasks_run_id
ON agent_tasks(run_id);

CREATE TRIGGER agent_tasks_require_run_id_insert
BEFORE INSERT ON agent_tasks
WHEN NEW.run_id IS NULL OR trim(NEW.run_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'agent_tasks.run_id is required');
END;

CREATE TRIGGER agent_tasks_require_run_id_update
BEFORE UPDATE OF run_id ON agent_tasks
WHEN NEW.run_id IS NULL OR trim(NEW.run_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'agent_tasks.run_id is required');
END;

ALTER TABLE context_bundles ADD COLUMN run_id TEXT;
UPDATE context_bundles
SET run_id = (
  SELECT task.run_id FROM agent_tasks task WHERE task.id = context_bundles.task_id
)
WHERE run_id IS NULL;
CREATE INDEX idx_context_bundles_run_created
ON context_bundles(run_id, created_at DESC);

ALTER TABLE agent_tool_calls ADD COLUMN run_id TEXT;
ALTER TABLE agent_tool_calls ADD COLUMN turn_id TEXT;
ALTER TABLE agent_tool_calls ADD COLUMN provider_tool_call_id TEXT;
UPDATE agent_tool_calls
SET run_id = (
  SELECT task.run_id FROM agent_tasks task WHERE task.id = agent_tool_calls.task_id
)
WHERE run_id IS NULL;
CREATE INDEX idx_agent_tool_calls_run_started
ON agent_tool_calls(run_id, started_at ASC);
CREATE UNIQUE INDEX idx_agent_tool_calls_provider_id
ON agent_tool_calls(run_id, provider_tool_call_id)
WHERE provider_tool_call_id IS NOT NULL;

DROP TRIGGER IF EXISTS approval_after_agent_confirmation;
ALTER TABLE approvals RENAME TO approvals_before_runtime_contracts;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  approval_kind TEXT NOT NULL DEFAULT 'mutation_approval'
    CHECK (approval_kind IN ('execution_authorization', 'mutation_approval', 'external_action_approval')),
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('task_run', 'change_set', 'tool_call', 'external_action')),
  entity_id TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (decision IN ('pending', 'approved', 'rejected', 'cancelled')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  actor_id TEXT NOT NULL DEFAULT 'local_user',
  request_json TEXT NOT NULL DEFAULT '{}',
  details_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  UNIQUE (entity_type, entity_id, approval_kind, created_at)
);

INSERT INTO approvals (
  id, approval_kind, entity_type, entity_id, decision, status, actor_id,
  request_json, details_json, run_id, correlation_id, causation_id, created_at, decided_at
)
SELECT id, 'mutation_approval', entity_type, entity_id, decision, decision, actor_id,
       '{}', details_json,
       CASE entity_type
         WHEN 'task_run' THEN entity_id
         WHEN 'change_set' THEN (
           SELECT task.run_id
           FROM change_sets change_set
           JOIN agent_tasks task ON task.id = change_set.agent_task_id
           WHERE change_set.id = approvals_before_runtime_contracts.entity_id
         )
         ELSE NULL
       END,
       correlation_id, NULL, created_at, created_at
FROM approvals_before_runtime_contracts;

DROP TABLE approvals_before_runtime_contracts;

CREATE INDEX idx_approvals_kind_status_created
ON approvals(approval_kind, status, created_at DESC);
CREATE INDEX idx_approvals_run_created
ON approvals(run_id, created_at DESC);

CREATE TRIGGER approvals_sync_legacy_decision
AFTER INSERT ON approvals
WHEN NEW.status = 'pending' AND NEW.decision IN ('approved', 'rejected', 'cancelled')
BEGIN
  UPDATE approvals SET status = NEW.decision, decided_at = COALESCE(decided_at, NEW.created_at)
  WHERE id = NEW.id;
END;

CREATE TRIGGER approval_after_agent_confirmation
AFTER INSERT ON agent_confirmations
WHEN NEW.action IN ('applied', 'rejected_set')
BEGIN
  INSERT OR IGNORE INTO approvals (
    id, approval_kind, entity_type, entity_id, decision, status, actor_id,
    request_json, details_json, run_id, correlation_id, causation_id, created_at, decided_at
  ) VALUES (
    'approval-agent-confirmation-' || NEW.id, 'mutation_approval',
    'change_set', 'changeset-agent-' || NEW.task_id,
    CASE NEW.action WHEN 'applied' THEN 'approved' ELSE 'rejected' END,
    CASE NEW.action WHEN 'applied' THEN 'approved' ELSE 'rejected' END,
    'local_user', '{}', NEW.details_json,
    (SELECT run_id FROM agent_tasks WHERE id = NEW.task_id),
    COALESCE((SELECT correlation_id FROM agent_tasks WHERE id = NEW.task_id), NEW.task_id),
    (SELECT causation_id FROM agent_tasks WHERE id = NEW.task_id),
    NEW.created_at, NEW.created_at
  );
  UPDATE change_sets SET status = 'rejected', updated_at = NEW.created_at
  WHERE id = 'changeset-agent-' || NEW.task_id
    AND NEW.action = 'rejected_set' AND status IN ('draft', 'proposed');
END;
