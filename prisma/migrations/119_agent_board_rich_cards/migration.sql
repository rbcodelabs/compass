-- Migration 119: rich agent board card metadata and live run activity.
-- Additive and behavior-neutral: five nullable columns across agent_conversations and agent_runs.
-- No DEFAULT, no NOT NULL, no foreign keys, no backfill, and no new indexes (Aurora DSQL rules).
--
--   agent_conversations.squad_id       optional owning Squad UUID for Squad grouping
--   agent_conversations.summary        1-line markdown-stripped outcome excerpt for idle cards
--   agent_conversations.pr_url         latest GitHub PR URL surfaced in the conversation
--   agent_runs.substatus               interactive pause sub-state while RUNNING (NULL = actively executing)
--   agent_runs.current_activity        latest humanized tool/subagent step for O(1) board reads
--
-- Runtime readers and writers tolerate this migration being unapplied (falling back on P2022).

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS squad_id UUID;

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS summary VARCHAR(500);

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS pr_url VARCHAR(500);

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS substatus VARCHAR(20);

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS current_activity VARCHAR(240);
