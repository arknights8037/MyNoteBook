CREATE TABLE agent_requests (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'awaiting_review', 'approved', 'rejected', 'completed', 'failed')),
  task_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES agent_tasks(id)
);

CREATE INDEX idx_agent_requests_status_created
ON agent_requests(status, created_at ASC);
