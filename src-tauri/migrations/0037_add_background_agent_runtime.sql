CREATE TABLE agent_background_runtime_profiles (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  profile_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE agent_requests ADD COLUMN run_id TEXT;
ALTER TABLE agent_requests ADD COLUMN cognitive_session_id TEXT;

CREATE UNIQUE INDEX idx_agent_requests_run_id
ON agent_requests(run_id)
WHERE run_id IS NOT NULL;

CREATE INDEX idx_agent_requests_cognitive_session
ON agent_requests(cognitive_session_id)
WHERE cognitive_session_id IS NOT NULL;
