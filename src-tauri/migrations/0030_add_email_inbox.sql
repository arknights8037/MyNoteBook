CREATE TABLE email_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0 AND length(display_name) <= 120),
  email_address TEXT NOT NULL CHECK (length(trim(email_address)) > 2 AND length(email_address) <= 254),
  imap_host TEXT NOT NULL CHECK (length(trim(imap_host)) > 0 AND length(imap_host) <= 253),
  imap_port INTEGER NOT NULL DEFAULT 993 CHECK (imap_port BETWEEN 1 AND 65535),
  username TEXT NOT NULL CHECK (length(trim(username)) > 0 AND length(username) <= 320),
  mailbox TEXT NOT NULL DEFAULT 'INBOX' CHECK (length(trim(mailbox)) > 0 AND length(mailbox) <= 255),
  auth_type TEXT NOT NULL DEFAULT 'password' CHECK (auth_type IN ('password')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_synced_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE email_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  remote_uid INTEGER NOT NULL CHECK (remote_uid >= 0),
  message_id TEXT,
  subject TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_json TEXT NOT NULL CHECK (json_valid(to_json)),
  received_at INTEGER NOT NULL,
  preview TEXT NOT NULL,
  body_text TEXT NOT NULL,
  attachment_count INTEGER NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
  server_is_read INTEGER NOT NULL DEFAULT 0 CHECK (server_is_read IN (0, 1)),
  processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'done', 'archived')),
  synced_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE,
  UNIQUE(account_id, mailbox, remote_uid)
);

CREATE INDEX idx_email_accounts_updated
ON email_accounts(enabled DESC, updated_at DESC, id ASC);

CREATE INDEX idx_email_messages_inbox
ON email_messages(processing_status, received_at DESC, id ASC);

CREATE INDEX idx_email_messages_account
ON email_messages(account_id, received_at DESC, id ASC);
