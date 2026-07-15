ALTER TABLE agent_requests ADD COLUMN previous_task_id TEXT;
ALTER TABLE agent_requests ADD COLUMN revision_feedback TEXT;
ALTER TABLE agent_requests ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_agent_requests_previous_task
ON agent_requests(previous_task_id, status, updated_at ASC);
