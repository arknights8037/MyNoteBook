DROP TRIGGER IF EXISTS views_stale_after_knowledge_update;

CREATE TABLE knowledge_relations_v14_backup AS
SELECT id, from_object_id, relation_type, to_object_id, created_at FROM knowledge_object_relations;
CREATE TABLE knowledge_task_sources_v14_backup AS
SELECT id, source_knowledge_object_id FROM task_definitions WHERE source_knowledge_object_id IS NOT NULL;
CREATE TABLE knowledge_view_dependencies_v14_backup AS
SELECT snapshot_id, view_id, source_type, knowledge_object_id, document_id, block_id, source_revision
FROM view_dependencies WHERE knowledge_object_id IS NOT NULL;

CREATE TABLE knowledge_objects_v14 (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN (
    'decision', 'rule', 'goal', 'task', 'evidence', 'change_set',
    'fact', 'claim', 'inference', 'assumption', 'concept', 'question', 'limitation'
  )),
  status TEXT NOT NULL CHECK (status IN ('draft', 'candidate', 'approved', 'active', 'deprecated', 'rejected')),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  structured_data_json TEXT NOT NULL DEFAULT '{}',
  generated_run_id TEXT,
  cognitive_mode TEXT,
  template_id TEXT,
  template_version INTEGER,
  owner_id TEXT,
  scope_json TEXT NOT NULL DEFAULT '{}',
  document_id TEXT,
  block_id TEXT,
  source_revision INTEGER,
  authority_level TEXT NOT NULL DEFAULT 'local',
  confidence REAL,
  valid_from INTEGER,
  valid_until INTEGER,
  verified_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL,
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK ((document_id IS NULL AND block_id IS NULL) OR document_id IS NOT NULL),
  CHECK (template_version IS NULL OR template_version > 0)
);

INSERT INTO knowledge_objects_v14 (
  id, object_type, status, title, owner_id, scope_json, document_id, block_id,
  source_revision, authority_level, confidence, valid_from, valid_until,
  verified_at, version, created_at, updated_at
)
SELECT id, object_type, status, title, owner_id, scope_json, document_id, block_id,
       source_revision, authority_level, confidence, valid_from, valid_until,
       verified_at, version, created_at, updated_at
FROM knowledge_objects;

DROP TABLE knowledge_objects;
ALTER TABLE knowledge_objects_v14 RENAME TO knowledge_objects;

CREATE INDEX idx_knowledge_objects_type_status ON knowledge_objects(object_type, status, updated_at DESC);
CREATE INDEX idx_knowledge_objects_document ON knowledge_objects(document_id, block_id);
CREATE INDEX idx_knowledge_objects_cognitive_run ON knowledge_objects(generated_run_id, cognitive_mode, status);
CREATE INDEX idx_knowledge_objects_authority_updated ON knowledge_objects(authority_level DESC, updated_at DESC, id ASC);

INSERT OR IGNORE INTO knowledge_object_relations
  (id, from_object_id, relation_type, to_object_id, created_at)
SELECT id, from_object_id, relation_type, to_object_id, created_at FROM knowledge_relations_v14_backup;
UPDATE task_definitions
SET source_knowledge_object_id = (
  SELECT backup.source_knowledge_object_id FROM knowledge_task_sources_v14_backup backup
  WHERE backup.id = task_definitions.id
)
WHERE id IN (SELECT id FROM knowledge_task_sources_v14_backup);
INSERT OR IGNORE INTO view_dependencies
  (snapshot_id, view_id, source_type, knowledge_object_id, document_id, block_id, source_revision)
SELECT snapshot_id, view_id, source_type, knowledge_object_id, document_id, block_id, source_revision
FROM knowledge_view_dependencies_v14_backup;
DROP TABLE knowledge_relations_v14_backup;
DROP TABLE knowledge_task_sources_v14_backup;
DROP TABLE knowledge_view_dependencies_v14_backup;

CREATE TABLE knowledge_object_sources (
  id TEXT PRIMARY KEY,
  knowledge_object_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  block_id TEXT,
  revision INTEGER NOT NULL,
  quote TEXT,
  start_offset INTEGER,
  end_offset INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (knowledge_object_id) REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  CHECK (revision > 0),
  CHECK (start_offset IS NULL OR start_offset >= 0),
  CHECK (end_offset IS NULL OR (start_offset IS NOT NULL AND end_offset >= start_offset)),
  UNIQUE (knowledge_object_id, document_id, block_id, revision, start_offset, end_offset)
);
INSERT INTO knowledge_object_sources (id, knowledge_object_id, document_id, block_id, revision, created_at)
SELECT 'legacy-source-' || id, id, document_id, block_id, source_revision, created_at
FROM knowledge_objects WHERE document_id IS NOT NULL AND source_revision IS NOT NULL;
CREATE INDEX idx_knowledge_sources_object ON knowledge_object_sources(knowledge_object_id, created_at ASC);
CREATE INDEX idx_knowledge_sources_document_revision ON knowledge_object_sources(document_id, block_id, revision);

CREATE TABLE knowledge_validations (
  id TEXT PRIMARY KEY,
  knowledge_object_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('passed', 'failed', 'warning', 'unverifiable')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  message TEXT NOT NULL,
  source_json TEXT NOT NULL DEFAULT '{}',
  validated_at INTEGER NOT NULL,
  FOREIGN KEY (knowledge_object_id) REFERENCES knowledge_objects(id) ON DELETE CASCADE
);
CREATE INDEX idx_knowledge_validations_object ON knowledge_validations(knowledge_object_id, validated_at DESC);

CREATE TABLE cognitive_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  mode_id TEXT NOT NULL CHECK (mode_id IN ('learning', 'research', 'review')),
  mode_version INTEGER NOT NULL,
  template_id TEXT,
  template_version INTEGER,
  skill_ids_json TEXT NOT NULL DEFAULT '[]',
  target_document_ids_json TEXT NOT NULL DEFAULT '[]',
  target_block_ids_json TEXT NOT NULL DEFAULT '[]',
  state_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('active', 'waiting_user', 'completed', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (mode_version > 0),
  CHECK (template_version IS NULL OR template_version > 0)
);
CREATE INDEX idx_cognitive_sessions_conversation_updated ON cognitive_sessions(conversation_id, updated_at DESC);
CREATE INDEX idx_cognitive_sessions_status_updated ON cognitive_sessions(status, updated_at DESC);

CREATE TRIGGER views_stale_after_knowledge_update
AFTER UPDATE OF version, status, updated_at ON knowledge_objects
BEGIN
  UPDATE view_snapshots SET status = 'stale'
  WHERE status <> 'stale' AND id IN (
    SELECT dependency.snapshot_id FROM view_dependencies dependency
    INNER JOIN view_definitions view ON view.current_snapshot_id = dependency.snapshot_id
    WHERE dependency.knowledge_object_id = NEW.id AND dependency.source_revision <> NEW.version
  );
  UPDATE view_definitions SET stale = 1, updated_at = NEW.updated_at
  WHERE stale <> 1 AND current_snapshot_id IN (
    SELECT dependency.snapshot_id FROM view_dependencies dependency
    WHERE dependency.knowledge_object_id = NEW.id AND dependency.source_revision <> NEW.version
  );
END;
