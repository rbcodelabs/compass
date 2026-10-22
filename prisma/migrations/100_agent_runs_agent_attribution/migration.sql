-- Migration 100: agent attribution on agent_runs
-- (ADR "Cloud agents as first-class identities", phase 2: run as the agent).
--
-- Additive and behavior-neutral: two nullable columns and two async indexes. No backfill:
-- a NULL agent_id is a legacy run and reads as the built-in "Compass Agent", and a NULL
-- invoked_by_user_id reads as user_id (the existing column stays the invoker during migration).
--
--   agent_id            the agents row this run acts as; NULL = built-in default agent
--   invoked_by_user_id  the human who started the run (for a shared agent, the only human in the run)
--
-- The composite (agent_id, created_at) index serves the per-agent concurrency and daily run caps
-- (phase 4) and the activity views; invoked_by_user_id serves "runs I started".
--
-- Aurora DSQL rules followed:
--   - No foreign keys: both columns are bare UUIDs validated in application code.
--   - ADD COLUMN carries no DEFAULT and no NOT NULL (DSQL rejects any constraint on it).
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - Indexes are CREATE INDEX ASYNC, with no ASC/DESC and no partial index.
--
-- Code that reads or writes these columns tolerates this migration being unapplied
-- (lib/agent-runs.ts falls back to the pre-100 column set on P2022).

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS agent_id UUID;

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS invoked_by_user_id UUID;

CREATE INDEX ASYNC IF NOT EXISTS agent_runs_agent_id_created_at_idx ON agent_runs(agent_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS agent_runs_invoked_by_user_id_idx ON agent_runs(invoked_by_user_id);
