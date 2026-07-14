CREATE TABLE IF NOT EXISTS context_bundles (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  scope_json TEXT NOT NULL,
  permission_snapshot_json TEXT NOT NULL DEFAULT '{}',
  sources_json TEXT NOT NULL DEFAULT '[]',
  active_rules_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  compiler_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_context_bundles_task_created
ON context_bundles(task_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_context_bundles_snapshot
ON context_bundles(task_id, snapshot_hash);

ALTER TABLE agent_tasks ADD COLUMN correlation_id TEXT;
ALTER TABLE agent_tasks ADD COLUMN causation_id TEXT;
ALTER TABLE agent_tasks ADD COLUMN execution_policy_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_tasks ADD COLUMN context_bundle_id TEXT;
ALTER TABLE agent_tasks ADD COLUMN provider TEXT;
ALTER TABLE agent_tasks ADD COLUMN model_parameters_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_tasks ADD COLUMN ignored_parameters_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_tasks ADD COLUMN skill_versions_json TEXT NOT NULL DEFAULT '[]';

UPDATE agent_tasks SET correlation_id = id WHERE correlation_id IS NULL;

ALTER TABLE agent_tool_calls ADD COLUMN correlation_id TEXT;
ALTER TABLE agent_tool_calls ADD COLUMN causation_id TEXT;
UPDATE agent_tool_calls
SET correlation_id = (SELECT correlation_id FROM agent_tasks WHERE agent_tasks.id = agent_tool_calls.task_id)
WHERE correlation_id IS NULL;

ALTER TABLE automation_runs ADD COLUMN correlation_id TEXT;
ALTER TABLE automation_runs ADD COLUMN causation_id TEXT;
UPDATE automation_runs SET correlation_id = id WHERE correlation_id IS NULL;
