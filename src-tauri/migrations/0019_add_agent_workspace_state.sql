CREATE TABLE IF NOT EXISTS agent_workspace_state (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE agent_tasks ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_tasks ADD COLUMN conversation_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_agent_tasks_project_created
ON agent_tasks(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_conversation_created
ON agent_tasks(conversation_id, created_at ASC);
