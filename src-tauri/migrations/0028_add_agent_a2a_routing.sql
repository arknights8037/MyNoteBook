CREATE TABLE agent_branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_conversation_id TEXT,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_agent_branches_project_updated
ON agent_branches(project_id, updated_at DESC);

ALTER TABLE agent_requests ADD COLUMN project_id TEXT;
ALTER TABLE agent_requests ADD COLUMN branch_id TEXT REFERENCES agent_branches(id);

CREATE INDEX idx_agent_requests_project_created
ON agent_requests(project_id, created_at ASC);

CREATE INDEX idx_agent_requests_branch_created
ON agent_requests(branch_id, created_at ASC);

