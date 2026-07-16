CREATE TABLE workspace_views (
  id TEXT PRIMARY KEY,
  view_type TEXT NOT NULL CHECK (view_type IN ('slides', 'uml', 'table')),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 160),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE workspace_view_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  view_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (view_id) REFERENCES workspace_views(id) ON DELETE CASCADE,
  UNIQUE(view_id, version)
);
CREATE INDEX idx_workspace_views_updated ON workspace_views(updated_at DESC, id ASC);
CREATE TRIGGER workspace_views_revision_after_insert AFTER INSERT ON workspace_views BEGIN
  INSERT INTO workspace_view_revisions(view_id, version, title, payload_json, created_at)
  VALUES (NEW.id, NEW.version, NEW.title, NEW.payload_json, NEW.updated_at);
END;
CREATE TRIGGER workspace_views_revision_after_update AFTER UPDATE OF title, payload_json, version ON workspace_views
WHEN NEW.version <> OLD.version BEGIN
  INSERT INTO workspace_view_revisions(view_id, version, title, payload_json, created_at)
  VALUES (NEW.id, NEW.version, NEW.title, NEW.payload_json, NEW.updated_at);
END;
