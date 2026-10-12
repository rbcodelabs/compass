-- Migration 080: durable Agent SDK session pointer for in-app agent conversations.
-- Additive: one new table, no index, no backfill. A conversation with no row simply
-- keeps using the text-replay prompt, so the code can ship before this is applied.
--
-- The transcript itself lives in a private Vercel Blob object; this row is the
-- pointer to the current revision of it (blob_key), plus the message it covers.
--
-- Aurora DSQL rules followed:
--   - No foreign keys: conversation_id / workspace_id are bare UUID columns.
--   - conversation_id is the PRIMARY KEY (at most one session per conversation),
--     so no separate index is needed and no async build is involved.
--   - No trigger: updated_at is set by the application on every write.

CREATE TABLE IF NOT EXISTS agent_sessions (
  conversation_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  session_id VARCHAR(64) NOT NULL,
  blob_key VARCHAR(512) NOT NULL,
  through_message_id UUID NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  byte_size INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
