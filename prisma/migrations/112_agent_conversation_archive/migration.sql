-- Migration 112: archive agent conversations.
-- Additive: one nullable column, no default, no backfill, no index (DSQL rules, see 055/105).
-- NULL = active. Set by the conversation owner to hide the chat from the conversation list.

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP(3);
