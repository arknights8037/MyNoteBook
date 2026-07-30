ALTER TABLE automation_tasks ADD COLUMN source_type TEXT NOT NULL DEFAULT 'document'
  CHECK (source_type IN ('document', 'rss'));

ALTER TABLE automation_tasks ADD COLUMN source_config_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(source_config_json));

ALTER TABLE automation_tasks ADD COLUMN source_cursor_at INTEGER;

ALTER TABLE automation_runs ADD COLUMN run_id TEXT;
ALTER TABLE automation_runs ADD COLUMN agent_task_id TEXT;
ALTER TABLE automation_runs ADD COLUMN source_cursor_at INTEGER;
ALTER TABLE automation_runs ADD COLUMN lease_owner TEXT;
ALTER TABLE automation_runs ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE automation_runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_runs ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE automation_runs ADD COLUMN dead_lettered_at INTEGER;
ALTER TABLE automation_runs ADD COLUMN last_failure_kind TEXT;

CREATE UNIQUE INDEX idx_automation_runs_run_id
ON automation_runs(run_id)
WHERE run_id IS NOT NULL;

CREATE INDEX idx_automation_runs_runtime_queue
ON automation_runs(status, next_attempt_at, queued_at)
WHERE status IN ('queued', 'running');

CREATE INDEX idx_automation_runs_runtime_lease
ON automation_runs(status, lease_expires_at)
WHERE status = 'running';

DROP TRIGGER IF EXISTS automation_task_run_after_status;

CREATE TRIGGER automation_task_run_after_status
AFTER UPDATE OF status, output_json, error, started_at, completed_at ON automation_runs
WHEN NEW.task_run_id IS NOT NULL
BEGIN
  UPDATE task_runs
  SET status = CASE NEW.status
      WHEN 'queued' THEN 'queued'
      WHEN 'running' THEN 'running'
      WHEN 'waiting_approval' THEN 'waiting_approval'
      WHEN 'completed' THEN 'completed'
      WHEN 'cancelled' THEN 'cancelled'
      ELSE 'failed' END,
      output_json = NEW.output_json,
      error = NEW.error,
      started_at = NEW.started_at,
      completed_at = NEW.completed_at
  WHERE id = NEW.task_run_id;
END;
