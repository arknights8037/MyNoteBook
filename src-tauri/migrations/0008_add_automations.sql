CREATE TABLE IF NOT EXISTS automation_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  instruction TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_config_json TEXT NOT NULL DEFAULT '{}',
  document_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_tasks_due
ON automation_tasks(enabled, next_run_at ASC);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT,
  trigger_source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  error TEXT,
  schedule_next_run_at INTEGER,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (automation_id) REFERENCES automation_tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_created
ON automation_runs(queued_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_runs_status
ON automation_runs(status, queued_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_active
ON automation_runs(automation_id)
WHERE automation_id IS NOT NULL AND status IN ('queued', 'running');

CREATE TRIGGER IF NOT EXISTS automation_runs_after_insert
AFTER INSERT ON automation_runs
WHEN NEW.automation_id IS NOT NULL
BEGIN
  UPDATE automation_tasks
  SET last_run_at = NEW.queued_at,
      next_run_at = NEW.schedule_next_run_at,
      updated_at = NEW.queued_at
  WHERE id = NEW.automation_id;
END;
