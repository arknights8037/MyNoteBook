ALTER TABLE agent_patches ADD COLUMN document_title TEXT;
ALTER TABLE agent_patches ADD COLUMN parent_document_id TEXT;

CREATE TABLE IF NOT EXISTS agent_document_creation_transactions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'applied',
  created_at INTEGER NOT NULL,
  rolled_back_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE RESTRICT
);
