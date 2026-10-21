CREATE TABLE IF NOT EXISTS inbox_messages (
  mailbox_id TEXT NOT NULL,
  id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, id)
);

CREATE INDEX IF NOT EXISTS inbox_messages_expiry ON inbox_messages (mailbox_id, expires_at);
CREATE INDEX IF NOT EXISTS inbox_messages_created ON inbox_messages (mailbox_id, created_at);
