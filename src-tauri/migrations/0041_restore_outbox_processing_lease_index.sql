CREATE INDEX idx_outbox_processing_lease
ON outbox_messages(lease_until, created_at ASC)
WHERE status = 'processing';
