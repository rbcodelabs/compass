-- Migration 107: per-user "reviewed" flag for the agent board.
-- Additive: one new table and two async indexes. No backfill and no change to an existing
-- table: a conversation with no row here simply reads as "not reviewed by this user", so the
-- code can ship before this is applied (the board degrades to every card being New).
--
-- agent_conversation_reviews: one row per (conversation, user) who has opened the conversation
-- from the board. reviewed_at is compared with the conversation's last activity, so activity
-- after a review makes the card New again without any write. The row is per user on purpose: a
-- shared conversation (agent_conversation_participants) must not share one reviewed state.
--
-- Aurora DSQL rules followed:
--   - No foreign keys: conversation_id / workspace_id / user_id are bare UUIDs validated in
--     application code (the write path goes through lib/agent-conversation-access.ts).
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - Indexes are CREATE [UNIQUE] INDEX ASYNC, with no ASC/DESC and no partial index.
--   - No trigger and no @updatedAt: updated_at is set by the application on every write.

CREATE TABLE IF NOT EXISTS agent_conversation_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  reviewed_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_agent_conversation_reviews_conversation_user ON agent_conversation_reviews(conversation_id, user_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_conversation_reviews_user_workspace ON agent_conversation_reviews(user_id, workspace_id);
