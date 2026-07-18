ALTER TABLE workspace_views ADD COLUMN pinned_at INTEGER;

CREATE INDEX idx_workspace_views_pinned
ON workspace_views(pinned_at DESC, parent_id, sort_order, updated_at DESC, id ASC);
