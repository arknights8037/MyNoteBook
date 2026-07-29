CREATE TABLE IF NOT EXISTS im_connectors (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('dingtalk')),
  display_name TEXT NOT NULL,
  source_category TEXT NOT NULL DEFAULT '未分类',
  client_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  runtime_status TEXT NOT NULL DEFAULT 'stopped'
    CHECK (runtime_status IN ('stopped', 'connecting', 'online', 'reconnecting', 'auth_error', 'error')),
  last_connected_at INTEGER,
  last_event_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider, client_id)
);

CREATE INDEX IF NOT EXISTS idx_im_connectors_status
  ON im_connectors(enabled, runtime_status);

CREATE TABLE IF NOT EXISTS im_conversations (
  id TEXT PRIMARY KEY NOT NULL,
  connector_id TEXT NOT NULL,
  remote_conversation_id TEXT NOT NULL,
  conversation_type TEXT NOT NULL CHECK (conversation_type IN ('direct', 'group')),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (connector_id) REFERENCES im_connectors(id) ON DELETE CASCADE,
  UNIQUE (connector_id, remote_conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_im_conversations_connector
  ON im_conversations(connector_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS im_messages (
  id TEXT PRIMARY KEY NOT NULL,
  connector_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  remote_message_id TEXT NOT NULL,
  sender_id TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  message_type TEXT NOT NULL,
  body_text TEXT NOT NULL,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'done', 'archived')),
  FOREIGN KEY (connector_id) REFERENCES im_connectors(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES im_conversations(id) ON DELETE CASCADE,
  UNIQUE (connector_id, remote_message_id)
);

CREATE INDEX IF NOT EXISTS idx_im_messages_status_time
  ON im_messages(processing_status, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_im_messages_connector_time
  ON im_messages(connector_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_im_messages_conversation_time
  ON im_messages(conversation_id, sent_at DESC);
