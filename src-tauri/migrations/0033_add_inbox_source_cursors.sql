ALTER TABLE email_accounts ADD COLUMN source_category TEXT NOT NULL DEFAULT '未分类'
  CHECK (length(trim(source_category)) > 0 AND length(source_category) <= 80);
ALTER TABLE email_accounts ADD COLUMN sync_cursor_at INTEGER;
ALTER TABLE email_accounts ADD COLUMN last_remote_uid INTEGER NOT NULL DEFAULT 0
  CHECK (last_remote_uid >= 0);

UPDATE email_accounts SET
  sync_cursor_at = (
    SELECT MAX(received_at) FROM email_messages WHERE account_id = email_accounts.id
  ),
  last_remote_uid = COALESCE((
    SELECT MAX(remote_uid) FROM email_messages WHERE account_id = email_accounts.id
  ), 0);

ALTER TABLE rss_sources ADD COLUMN source_category TEXT NOT NULL DEFAULT '未分类'
  CHECK (length(trim(source_category)) > 0 AND length(source_category) <= 80);
ALTER TABLE rss_sources ADD COLUMN sync_cursor_at INTEGER;

UPDATE rss_sources SET sync_cursor_at = (
  SELECT MAX(COALESCE(updated_at, published_at))
  FROM rss_entries WHERE source_id = rss_sources.id
);
