CREATE TABLE IF NOT EXISTS information_home (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'default'),
  payload_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  auto_summary_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_summary_enabled IN (0, 1)),
  summary_interval_minutes INTEGER NOT NULL DEFAULT 360
    CHECK (summary_interval_minutes BETWEEN 30 AND 10080),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS information_home_summaries (
  id TEXT PRIMARY KEY NOT NULL,
  home_id TEXT NOT NULL DEFAULT 'default',
  source_cursor_at INTEGER NOT NULL,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('manual', 'auto')),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  content TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  error TEXT,
  generated_at INTEGER NOT NULL,
  FOREIGN KEY (home_id) REFERENCES information_home(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_information_home_summaries_time
  ON information_home_summaries(home_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_information_home_summaries_cursor
  ON information_home_summaries(home_id, source_cursor_at DESC);
