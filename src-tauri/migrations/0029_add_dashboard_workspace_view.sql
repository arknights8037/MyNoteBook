CREATE TABLE workspace_views_next (
  id TEXT PRIMARY KEY,
  view_type TEXT NOT NULL CHECK (view_type IN ('slides', 'uml', 'table', 'dashboard')),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 160),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  pinned_at INTEGER
);

INSERT INTO workspace_views_next(
  id, view_type, title, payload_json, schema_version, version,
  created_at, updated_at, parent_id, sort_order, pinned_at
)
SELECT
  id, view_type, title, payload_json, schema_version, version,
  created_at, updated_at, parent_id, sort_order, pinned_at
FROM workspace_views;

CREATE TABLE workspace_view_revisions_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  view_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (view_id) REFERENCES workspace_views_next(id) ON DELETE CASCADE,
  UNIQUE(view_id, version)
);

INSERT INTO workspace_view_revisions_next(id, view_id, version, title, payload_json, created_at)
SELECT id, view_id, version, title, payload_json, created_at
FROM workspace_view_revisions;

DROP TABLE workspace_view_revisions;
DROP TABLE workspace_views;
ALTER TABLE workspace_views_next RENAME TO workspace_views;
ALTER TABLE workspace_view_revisions_next RENAME TO workspace_view_revisions;

CREATE INDEX idx_workspace_views_updated
ON workspace_views(updated_at DESC, id ASC);
CREATE INDEX idx_workspace_views_parent_sort
ON workspace_views(parent_id, sort_order, updated_at DESC, id ASC);
CREATE INDEX idx_workspace_views_pinned
ON workspace_views(pinned_at DESC, parent_id, sort_order, updated_at DESC, id ASC);

CREATE TRIGGER workspace_views_revision_after_insert AFTER INSERT ON workspace_views BEGIN
  INSERT INTO workspace_view_revisions(view_id, version, title, payload_json, created_at)
  VALUES (NEW.id, NEW.version, NEW.title, NEW.payload_json, NEW.updated_at);
END;

CREATE TRIGGER workspace_views_revision_after_update AFTER UPDATE OF title, payload_json, version ON workspace_views
WHEN NEW.version <> OLD.version BEGIN
  INSERT INTO workspace_view_revisions(view_id, version, title, payload_json, created_at)
  VALUES (NEW.id, NEW.version, NEW.title, NEW.payload_json, NEW.updated_at);
END;
