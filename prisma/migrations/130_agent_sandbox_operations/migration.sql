-- Launches and stops share one durable owner per conversation. The token fences
-- stale writers, including a sweeper that lost its reservation before dispatch.
CREATE TABLE IF NOT EXISTS agent_sandbox_operations (
  conversation_id UUID PRIMARY KEY,
  run_id UUID NOT NULL,
  sandbox_name TEXT NOT NULL,
  token UUID NOT NULL,
  phase TEXT NOT NULL,
  retry_at TIMESTAMPTZ
);

-- A distinct write token gives Postgres and DSQL a common conflict point
-- without changing conversation recency on a background sweep.
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS sandbox_coordination_token UUID;
