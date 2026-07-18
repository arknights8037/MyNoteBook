ALTER TABLE agent_requests ADD COLUMN mode TEXT NOT NULL DEFAULT 'agent'
  CHECK (mode IN ('agent', 'research', 'review', 'learning'));

