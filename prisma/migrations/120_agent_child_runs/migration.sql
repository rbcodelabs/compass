-- Migration 120: durable projection of harness-native child subagents (Task / Agent tool calls).
-- Additive: one new table (agent_child_runs) and three async indexes. No backfill and no change to an
-- existing table: when unapplied, runtime writers skip child-run projection and board/chat readers fall
-- back to empty durable child-run lists.
--
-- Aurora DSQL rules followed:
--   - No foreign keys: conversation_id / run_id / workspace_id / parent_child_run_id are bare UUIDs
--     validated in application code.
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - Indexes are CREATE [UNIQUE] INDEX ASYNC, with no ASC/DESC and no partial index.
--   - JSON step timelines serialized as TEXT (steps_json).
--   - No trigger and no @updatedAt: updated_at is set explicitly by the application on every write.

CREATE TABLE IF NOT EXISTS agent_child_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  run_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  native_agent_id VARCHAR(191) NOT NULL,
  parent_child_run_id UUID,
  parent_native_agent_id VARCHAR(191),
  role VARCHAR(191) NOT NULL,
  description VARCHAR(500) NOT NULL,
  status VARCHAR(20) NOT NULL,
  current_activity VARCHAR(240),
  step_count INTEGER NOT NULL DEFAULT 0,
  steps_json TEXT,
  result_summary TEXT,
  started_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_agent_child_runs_run_native ON agent_child_runs(run_id, native_agent_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_child_runs_conversation_started ON agent_child_runs(conversation_id, started_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_child_runs_workspace_conversation ON agent_child_runs(workspace_id, conversation_id);
