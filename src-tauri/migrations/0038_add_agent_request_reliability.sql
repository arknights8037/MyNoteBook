ALTER TABLE agent_requests ADD COLUMN lease_owner TEXT;
ALTER TABLE agent_requests ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE agent_requests ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_requests ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE agent_requests ADD COLUMN dead_lettered_at INTEGER;
ALTER TABLE agent_requests ADD COLUMN last_failure_kind TEXT;

CREATE INDEX idx_agent_requests_retry_schedule
ON agent_requests(status, next_attempt_at, created_at ASC);

CREATE INDEX idx_agent_requests_expired_lease
ON agent_requests(status, lease_expires_at)
WHERE status = 'running';

CREATE INDEX idx_agent_requests_dead_letter
ON agent_requests(dead_lettered_at DESC)
WHERE dead_lettered_at IS NOT NULL;
