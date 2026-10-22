-- Migration 102: per-agent run caps
-- (ADR "Cloud agents as first-class identities", phase 4: triggers and caps).
--
-- Additive and behavior-neutral: two nullable columns on agents, no index, no backfill.
--
--   max_concurrent_runs  most non-terminal runs this agent may have at once; NULL = the default (5)
--   max_runs_per_day     most runs this agent may start in a rolling 24 hours;   NULL = the default (100)
--
-- The counts themselves are read from agent_runs through the (agent_id, created_at) index that
-- migration 100 already built, so nothing here needs an index.
--
-- Aurora DSQL rules followed:
--   - ADD COLUMN carries no DEFAULT and no NOT NULL (DSQL rejects any constraint on it).
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--
-- Code that reads or writes these columns tolerates this migration being unapplied
-- (lib/agent-limits.ts treats a missing column as "use the defaults").

ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_concurrent_runs INTEGER;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_runs_per_day INTEGER;
