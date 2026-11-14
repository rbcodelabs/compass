-- Migration 121: interactive agent run controls — AskUserQuestion inbox items and ScheduleWakeup timers.
-- Additive: two new tables (agent_inbox_items, agent_scheduled_wakeups) and six async indexes. No backfill
-- and no change to an existing table: when unapplied, runtime readers and writers degrade gracefully on
-- missing-table errors (P2021).
--
-- Aurora DSQL rules followed:
--   - No foreign keys: workspace_id / conversation_id / run_id / user_id / agent_id are bare UUIDs
--     validated in application code.
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - Indexes are CREATE INDEX ASYNC IF NOT EXISTS, with no ASC/DESC and no partial predicate.
--   - Structured options serialized as TEXT (options_json).
--   - No trigger and no @updatedAt: updated_at is set explicitly by the application on every write.

CREATE TABLE IF NOT EXISTS agent_inbox_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  recipient_user_id UUID,
  source_conversation_id UUID,
  run_id UUID,
  native_tool_use_id VARCHAR(191),
  kind VARCHAR(30) NOT NULL,
  header VARCHAR(120),
  question TEXT NOT NULL,
  options_json TEXT,
  multi_select BOOLEAN NOT NULL DEFAULT false,
  allow_other BOOLEAN NOT NULL DEFAULT true,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  answer_text TEXT,
  resolved_by_user_id UUID,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_inbox_items_conversation_status ON agent_inbox_items(conversation_id, status, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_inbox_items_workspace_recipient ON agent_inbox_items(workspace_id, recipient_user_id, status);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_inbox_items_run_status ON agent_inbox_items(run_id, status);

CREATE TABLE IF NOT EXISTS agent_scheduled_wakeups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  user_id UUID NOT NULL,
  agent_id UUID,
  source_run_id UUID,
  fire_at TIMESTAMP(3) NOT NULL,
  delay_seconds INTEGER NOT NULL,
  reason VARCHAR(300),
  prompt TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  fired_run_id UUID,
  failure_reason VARCHAR(500),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fired_at TIMESTAMP(3),
  canceled_at TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_scheduled_wakeups_status_fire_at ON agent_scheduled_wakeups(status, fire_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_scheduled_wakeups_conversation_status ON agent_scheduled_wakeups(conversation_id, status, fire_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_scheduled_wakeups_workspace_status ON agent_scheduled_wakeups(workspace_id, status);
