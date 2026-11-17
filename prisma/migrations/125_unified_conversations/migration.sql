-- Migration 125: Unified Conversations model (OPP-67 / SOL-117).
-- Additive nullable columns on agent_conversations and agent_messages (Aurora DSQL rules: no DEFAULT, no NOT NULL, no FKs).

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS target_type VARCHAR(40);

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS target_id UUID;

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS visibility VARCHAR(20);

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS status VARCHAR(20);

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS agent_mode VARCHAR(20);

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS source VARCHAR(20);

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP(3);

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS resolved_by_id UUID;

ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS author_name VARCHAR(255);

ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS author_type VARCHAR(20);

ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS message_kind VARCHAR(30);

ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP(3);
