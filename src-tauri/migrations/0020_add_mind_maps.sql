CREATE TABLE mind_maps (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 160),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_actor_type TEXT NOT NULL CHECK (last_actor_type IN ('user', 'agent', 'system')),
  last_actor_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE mind_map_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mind_map_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (mind_map_id) REFERENCES mind_maps(id) ON DELETE CASCADE,
  UNIQUE (mind_map_id, version)
);

CREATE INDEX idx_mind_maps_updated ON mind_maps(updated_at DESC, id ASC);
CREATE INDEX idx_mind_map_revisions_map_version
ON mind_map_revisions(mind_map_id, version DESC);

CREATE TRIGGER mind_maps_revision_after_insert
AFTER INSERT ON mind_maps
BEGIN
  INSERT INTO mind_map_revisions (
    mind_map_id, version, title, content_json, actor_type, actor_id, created_at
  ) VALUES (
    NEW.id, NEW.version, NEW.title, NEW.content_json,
    NEW.last_actor_type, NEW.last_actor_id, NEW.updated_at
  );
END;

CREATE TRIGGER mind_maps_revision_after_update
AFTER UPDATE OF title, content_json, version ON mind_maps
WHEN NEW.version <> OLD.version
BEGIN
  INSERT INTO mind_map_revisions (
    mind_map_id, version, title, content_json, actor_type, actor_id, created_at
  ) VALUES (
    NEW.id, NEW.version, NEW.title, NEW.content_json,
    NEW.last_actor_type, NEW.last_actor_id, NEW.updated_at
  );
END;
