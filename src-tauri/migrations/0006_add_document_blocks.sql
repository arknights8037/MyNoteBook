CREATE TABLE IF NOT EXISTS blocks (
  document_id TEXT NOT NULL,
  id TEXT NOT NULL,
  block_type TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  plain_text TEXT NOT NULL DEFAULT '',
  document_revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, id),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blocks_document_order ON blocks(document_id, block_index);
CREATE INDEX IF NOT EXISTS idx_blocks_id ON blocks(id);

INSERT OR REPLACE INTO blocks (
  document_id, id, block_type, block_index, content_json, plain_text,
  document_revision, updated_at
)
SELECT
  documents.id,
  json_extract(block.value, '$.attrs.id'),
  COALESCE(json_extract(block.value, '$.type'), 'paragraph'),
  CAST(block.key AS INTEGER),
  block.value,
  COALESCE(
    NULLIF((SELECT group_concat(text_node.atom, '')
      FROM json_tree(block.value) AS text_node
      WHERE text_node.key = 'text' AND text_node.type = 'text'), ''),
    json_extract(block.value, '$.attrs.latex'),
    ''
  ),
  documents.revision,
  documents.updated_at
FROM documents, json_each(documents.content_json, '$.content') AS block
WHERE documents.document_kind = 'article'
  AND documents.is_deleted = 0
  AND json_extract(block.value, '$.attrs.id') IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS blocks_after_document_insert
AFTER INSERT ON documents
WHEN NEW.document_kind = 'article' AND NEW.is_deleted = 0
BEGIN
  INSERT OR REPLACE INTO blocks (
    document_id, id, block_type, block_index, content_json, plain_text,
    document_revision, updated_at
  )
  SELECT NEW.id, json_extract(block.value, '$.attrs.id'),
    COALESCE(json_extract(block.value, '$.type'), 'paragraph'), CAST(block.key AS INTEGER),
    block.value,
    COALESCE(
      NULLIF((SELECT group_concat(text_node.atom, '')
        FROM json_tree(block.value) AS text_node
        WHERE text_node.key = 'text' AND text_node.type = 'text'), ''),
      json_extract(block.value, '$.attrs.latex'), ''
    ),
    NEW.revision, NEW.updated_at
  FROM json_each(NEW.content_json, '$.content') AS block
  WHERE json_extract(block.value, '$.attrs.id') IS NOT NULL;
END;

CREATE TRIGGER IF NOT EXISTS blocks_after_document_update
AFTER UPDATE OF content_json, revision, is_deleted, document_kind ON documents
BEGIN
  DELETE FROM blocks WHERE document_id = OLD.id;
  INSERT OR REPLACE INTO blocks (
    document_id, id, block_type, block_index, content_json, plain_text,
    document_revision, updated_at
  )
  SELECT NEW.id, json_extract(block.value, '$.attrs.id'),
    COALESCE(json_extract(block.value, '$.type'), 'paragraph'), CAST(block.key AS INTEGER),
    block.value,
    COALESCE(
      NULLIF((SELECT group_concat(text_node.atom, '')
        FROM json_tree(block.value) AS text_node
        WHERE text_node.key = 'text' AND text_node.type = 'text'), ''),
      json_extract(block.value, '$.attrs.latex'), ''
    ),
    NEW.revision, NEW.updated_at
  FROM json_each(NEW.content_json, '$.content') AS block
  WHERE NEW.document_kind = 'article' AND NEW.is_deleted = 0
    AND json_extract(block.value, '$.attrs.id') IS NOT NULL;
END;

CREATE TRIGGER IF NOT EXISTS blocks_after_document_delete
AFTER DELETE ON documents
BEGIN
  DELETE FROM blocks WHERE document_id = OLD.id;
END;
