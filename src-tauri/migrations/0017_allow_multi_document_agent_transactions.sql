ALTER TABLE agent_document_transactions
RENAME TO agent_document_transactions_legacy;

CREATE TABLE agent_document_transactions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
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
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE RESTRICT,
  UNIQUE (task_id, document_id)
);

INSERT INTO agent_document_transactions (
  id, task_id, document_id, before_revision, resulting_revision,
  before_content_json, before_plain_text, after_content_json, after_plain_text,
  status, created_at, rolled_back_at
)
SELECT
  id, task_id, document_id, before_revision, resulting_revision,
  before_content_json, before_plain_text, after_content_json, after_plain_text,
  status, created_at, rolled_back_at
FROM agent_document_transactions_legacy;

DROP TABLE agent_document_transactions_legacy;

CREATE INDEX idx_agent_document_transactions_task
ON agent_document_transactions(task_id, created_at ASC);

CREATE INDEX idx_agent_document_transactions_document
ON agent_document_transactions(document_id, created_at DESC);
