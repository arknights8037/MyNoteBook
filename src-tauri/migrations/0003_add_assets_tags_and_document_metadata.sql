ALTER TABLE documents
ADD COLUMN source_url TEXT NOT NULL DEFAULT '';

ALTER TABLE documents
ADD COLUMN author TEXT NOT NULL DEFAULT '';

ALTER TABLE documents
ADD COLUMN description TEXT NOT NULL DEFAULT '';

ALTER TABLE assets
ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';

ALTER TABLE assets
ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, tag_id),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_tags_tag
ON document_tags(tag_id);
