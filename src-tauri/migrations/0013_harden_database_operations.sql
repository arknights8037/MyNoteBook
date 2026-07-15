DROP TRIGGER IF EXISTS blocks_after_document_insert;
DROP TRIGGER IF EXISTS blocks_after_document_update;
DROP TRIGGER IF EXISTS blocks_after_document_delete;
DROP INDEX IF EXISTS idx_blocks_id;

CREATE TABLE assets_v13 (
  id TEXT PRIMARY KEY,
  document_id TEXT,
  relative_path TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

INSERT INTO assets_v13 (
  id, document_id, relative_path, original_name, mime_type, size_bytes,
  width, height, created_at, content_hash, updated_at
)
SELECT id, document_id, relative_path, original_name, mime_type, size_bytes,
       width, height, created_at, content_hash, updated_at
FROM assets;

DROP TABLE assets;
ALTER TABLE assets_v13 RENAME TO assets;

DELETE FROM view_dependencies
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM view_dependencies
  GROUP BY snapshot_id, source_type, COALESCE(knowledge_object_id, ''),
           COALESCE(document_id, ''), COALESCE(block_id, '')
);

CREATE UNIQUE INDEX idx_view_dependencies_source_unique
ON view_dependencies(
  snapshot_id,
  source_type,
  COALESCE(knowledge_object_id, ''),
  COALESCE(document_id, ''),
  COALESCE(block_id, '')
);

DROP TRIGGER IF EXISTS views_stale_after_document_revision;
DROP TRIGGER IF EXISTS views_stale_after_knowledge_update;

CREATE TRIGGER views_stale_after_document_revision
AFTER UPDATE OF revision ON documents
WHEN NEW.revision <> OLD.revision
BEGIN
  UPDATE view_snapshots
  SET status = 'stale'
  WHERE status <> 'stale' AND id IN (
    SELECT dependency.snapshot_id
    FROM view_dependencies dependency
    INNER JOIN view_definitions view ON view.current_snapshot_id = dependency.snapshot_id
    WHERE dependency.document_id = NEW.id AND dependency.source_revision <> NEW.revision
  );
  UPDATE view_definitions
  SET stale = 1, updated_at = NEW.updated_at
  WHERE stale <> 1 AND current_snapshot_id IN (
    SELECT dependency.snapshot_id
    FROM view_dependencies dependency
    WHERE dependency.document_id = NEW.id AND dependency.source_revision <> NEW.revision
  );
END;

CREATE TRIGGER views_stale_after_knowledge_update
AFTER UPDATE OF version, status, updated_at ON knowledge_objects
BEGIN
  UPDATE view_snapshots
  SET status = 'stale'
  WHERE status <> 'stale' AND id IN (
    SELECT dependency.snapshot_id
    FROM view_dependencies dependency
    INNER JOIN view_definitions view ON view.current_snapshot_id = dependency.snapshot_id
    WHERE dependency.knowledge_object_id = NEW.id AND dependency.source_revision <> NEW.version
  );
  UPDATE view_definitions
  SET stale = 1, updated_at = NEW.updated_at
  WHERE stale <> 1 AND current_snapshot_id IN (
    SELECT dependency.snapshot_id
    FROM view_dependencies dependency
    WHERE dependency.knowledge_object_id = NEW.id AND dependency.source_revision <> NEW.version
  );
END;

CREATE INDEX idx_task_runs_queued_desc ON task_runs(queued_at DESC);
CREATE INDEX idx_knowledge_objects_authority_updated
ON knowledge_objects(authority_level DESC, updated_at DESC, id ASC);
CREATE INDEX idx_outbox_processing_lease
ON outbox_messages(lease_until, created_at ASC) WHERE status = 'processing';

UPDATE task_runs
SET status = (
      SELECT CASE run.status
        WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running'
        WHEN 'completed' THEN 'completed' WHEN 'cancelled' THEN 'cancelled'
        ELSE 'failed' END
      FROM automation_runs run WHERE run.task_run_id = task_runs.id
    ),
    output_json = (SELECT output_json FROM automation_runs WHERE task_run_id = task_runs.id),
    error = (SELECT error FROM automation_runs WHERE task_run_id = task_runs.id),
    started_at = (SELECT started_at FROM automation_runs WHERE task_run_id = task_runs.id),
    completed_at = (SELECT completed_at FROM automation_runs WHERE task_run_id = task_runs.id)
WHERE id IN (SELECT task_run_id FROM automation_runs WHERE task_run_id IS NOT NULL);

UPDATE task_runs
SET status = (
      SELECT CASE task.status
        WHEN 'pending' THEN 'queued' WHEN 'running' THEN 'running'
        WHEN 'waiting_confirmation' THEN 'waiting_approval'
        WHEN 'completed' THEN 'completed' WHEN 'cancelled' THEN 'cancelled'
        ELSE 'failed' END
      FROM agent_tasks task WHERE task.task_run_id = task_runs.id
    ),
    error = (SELECT error FROM agent_tasks WHERE task_run_id = task_runs.id),
    completed_at = (SELECT completed_at FROM agent_tasks WHERE task_run_id = task_runs.id),
    context_bundle_id = (SELECT context_bundle_id FROM agent_tasks WHERE task_run_id = task_runs.id)
WHERE id IN (SELECT task_run_id FROM agent_tasks WHERE task_run_id IS NOT NULL);

CREATE TRIGGER guard_automation_task_run_projection
BEFORE UPDATE OF status, output_json, error, started_at, completed_at ON task_runs
WHEN EXISTS (
  SELECT 1 FROM automation_runs run
  WHERE run.task_run_id = OLD.id AND (
    NEW.status <> CASE run.status
      WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running'
      WHEN 'completed' THEN 'completed' WHEN 'cancelled' THEN 'cancelled'
      ELSE 'failed' END
    OR NEW.output_json IS NOT run.output_json
    OR NEW.error IS NOT run.error
    OR NEW.started_at IS NOT run.started_at
    OR NEW.completed_at IS NOT run.completed_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'mapped automation TaskRun is a read-only projection');
END;

CREATE TRIGGER guard_agent_task_run_projection
BEFORE UPDATE OF status, error, completed_at, context_bundle_id ON task_runs
WHEN EXISTS (
  SELECT 1 FROM agent_tasks task
  WHERE task.task_run_id = OLD.id AND (
    NEW.status <> CASE task.status
      WHEN 'pending' THEN 'queued' WHEN 'running' THEN 'running'
      WHEN 'waiting_confirmation' THEN 'waiting_approval'
      WHEN 'completed' THEN 'completed' WHEN 'cancelled' THEN 'cancelled'
      ELSE 'failed' END
    OR NEW.error IS NOT task.error
    OR NEW.completed_at IS NOT task.completed_at
    OR NEW.context_bundle_id IS NOT task.context_bundle_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'mapped agent TaskRun is a read-only projection');
END;
