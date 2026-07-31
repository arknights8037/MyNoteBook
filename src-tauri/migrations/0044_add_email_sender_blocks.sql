CREATE TABLE email_blocked_senders (
  account_id TEXT NOT NULL,
  sender_address TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(sender_address)) > 2 AND length(sender_address) <= 320),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, sender_address),
  FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_email_blocked_senders_account
ON email_blocked_senders(account_id, created_at DESC, sender_address ASC);
