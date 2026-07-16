ALTER TABLE mind_maps ADD COLUMN parent_id TEXT;
ALTER TABLE mind_maps ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_mind_maps_parent_sort
ON mind_maps(parent_id, sort_order, updated_at DESC, id ASC);
