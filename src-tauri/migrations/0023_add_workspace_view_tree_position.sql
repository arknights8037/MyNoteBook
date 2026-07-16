ALTER TABLE workspace_views ADD COLUMN parent_id TEXT;
ALTER TABLE workspace_views ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_workspace_views_parent_sort
ON workspace_views(parent_id, sort_order, updated_at DESC, id ASC);
