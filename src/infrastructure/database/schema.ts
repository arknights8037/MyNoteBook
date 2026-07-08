export const CREATE_DOCUMENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  document_kind TEXT NOT NULL DEFAULT 'article',
  title TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,
  plain_text TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES documents(id)
);
`

export const CREATE_DOCUMENTS_PARENT_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_documents_parent
ON documents(parent_id, sort_order);
`

export const CREATE_DOCUMENTS_UPDATED_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_documents_updated
ON documents(updated_at DESC);
`

export const CREATE_ASSETS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  document_id TEXT,
  relative_path TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);
`

export const CREATE_TAGS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
`

export const CREATE_DOCUMENT_TAGS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, tag_id),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
`

export const CREATE_DOCUMENT_TAGS_TAG_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_document_tags_tag
ON document_tags(tag_id);
`
