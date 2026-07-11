CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  status TEXT NOT NULL,
  user_instruction TEXT NOT NULL,
  context_scope TEXT NOT NULL,
  model TEXT NOT NULL,
  current_step TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_document_created
ON agent_tasks(document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_patch_sets (
  task_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_patches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  document_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  target_block_ids_json TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  before_text TEXT NOT NULL,
  after_text TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_patches_task
ON agent_patches(task_id, created_at ASC);

CREATE TABLE IF NOT EXISTS agent_task_sources (
  task_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_title TEXT NOT NULL,
  block_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, document_id),
  FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  patch_id TEXT,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (patch_id) REFERENCES agent_patches(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_confirmations_task
ON agent_confirmations(task_id, created_at ASC);

CREATE TABLE IF NOT EXISTS agent_document_transactions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL,
  before_revision INTEGER NOT NULL,
  resulting_revision INTEGER NOT NULL,
  before_content_json TEXT NOT NULL,
  before_plain_text TEXT NOT NULL,
  after_content_json TEXT NOT NULL,
  after_plain_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied',
  created_at INTEGER NOT NULL,
  rolled_back_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_document_transactions_document
ON agent_document_transactions(document_id, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
  document_id UNINDEXED,
  title,
  plain_text,
  tokenize = 'unicode61'
);

INSERT INTO document_search (document_id, title, plain_text)
SELECT id, title, plain_text
FROM documents
WHERE is_deleted = 0
  AND NOT EXISTS (
    SELECT 1 FROM document_search WHERE document_search.document_id = documents.id
  );

CREATE TRIGGER IF NOT EXISTS documents_search_after_insert
AFTER INSERT ON documents
WHEN NEW.is_deleted = 0
BEGIN
  INSERT INTO document_search (document_id, title, plain_text)
  VALUES (NEW.id, NEW.title, NEW.plain_text);
END;

CREATE TRIGGER IF NOT EXISTS documents_search_after_update
AFTER UPDATE OF title, plain_text, is_deleted ON documents
BEGIN
  DELETE FROM document_search WHERE document_id = OLD.id;
  INSERT INTO document_search (document_id, title, plain_text)
  SELECT NEW.id, NEW.title, NEW.plain_text WHERE NEW.is_deleted = 0;
END;

CREATE TRIGGER IF NOT EXISTS documents_search_after_delete
AFTER DELETE ON documents
BEGIN
  DELETE FROM document_search WHERE document_id = OLD.id;
END;
