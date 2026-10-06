-- Migration 082: multi-user agent conversations.
-- Additive: one new table, two async indexes, and one nullable column on an existing
-- table. No backfill: the conversation OWNER is still AgentConversation.user_id, so
-- this table holds PARTICIPANT rows only and a conversation with no rows here behaves
-- exactly as it did before. The code can ship before this is applied.
--
-- agent_conversation_participants: one row per (conversation, invited user).
--   removed_at IS NULL     -> active participant
--   removed_at IS NOT NULL -> removed or left; re-inviting clears it (the unique index
--                             keeps a user to a single row per conversation)
--   added_by_user_id       -> who invited them. Any participant may invite (no cap).
--
-- agent_messages.author_user_id: who sent a user message, or who asked for an assistant
-- one (usage is charged to them). NULL for every message that existed before this
-- migration (treated as the owner's).
--
-- Aurora DSQL rules followed:
--   - No foreign keys: every *_id column is a bare UUID validated in application code.
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - Indexes are CREATE [UNIQUE] INDEX ASYNC, with no ASC/DESC and no partial index.
--   - ADD COLUMN carries no DEFAULT and no NOT NULL (DSQL rejects any constraint on it).
--   - No trigger: updated_at is set by the application on every write.

CREATE TABLE IF NOT EXISTS agent_conversation_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'PARTICIPANT',
  added_by_user_id UUID NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at TIMESTAMP(3)
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_agent_conversation_participants_conversation_user ON agent_conversation_participants(conversation_id, user_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_conversation_participants_user_workspace ON agent_conversation_participants(user_id, workspace_id);

ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS author_user_id UUID;
