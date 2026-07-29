ALTER TABLE rss_entries ADD COLUMN content_source TEXT NOT NULL DEFAULT 'summary'
  CHECK (content_source IN ('summary', 'feed', 'article'));

ALTER TABLE rss_entries ADD COLUMN article_fetched_at INTEGER;

ALTER TABLE rss_entries ADD COLUMN article_fetch_error TEXT;
