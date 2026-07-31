CREATE TRIGGER cleanup_email_messages_after_sender_block
AFTER INSERT ON email_blocked_senders
BEGIN
  DELETE FROM email_messages
  WHERE account_id = NEW.account_id
    AND from_address = NEW.sender_address COLLATE NOCASE;
END;

CREATE TRIGGER cleanup_email_messages_after_sender_reblock
AFTER UPDATE ON email_blocked_senders
BEGIN
  DELETE FROM email_messages
  WHERE account_id = NEW.account_id
    AND from_address = NEW.sender_address COLLATE NOCASE;
END;
