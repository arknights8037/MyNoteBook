CREATE TABLE rss_sources (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0 AND length(display_name) <= 160),
  feed_url TEXT NOT NULL UNIQUE CHECK (length(trim(feed_url)) > 7 AND length(feed_url) <= 2048),
  site_url TEXT,
  description TEXT NOT NULL DEFAULT '',
  etag TEXT,
  last_modified TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_synced_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rss_entries (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  article_url TEXT,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  published_at INTEGER NOT NULL,
  updated_at INTEGER,
  preview TEXT NOT NULL,
  body_text TEXT NOT NULL,
  categories_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(categories_json)),
  processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'done', 'archived')),
  synced_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES rss_sources(id) ON DELETE CASCADE,
  UNIQUE(source_id, remote_id)
);

CREATE INDEX idx_rss_sources_updated
ON rss_sources(enabled DESC, updated_at DESC, id ASC);

CREATE INDEX idx_rss_entries_inbox
ON rss_entries(processing_status, published_at DESC, id ASC);

CREATE INDEX idx_rss_entries_source
ON rss_entries(source_id, published_at DESC, id ASC);
