-- Migration 104: created_at indexes for the agent-data retention job (lib/agent-retention.ts).
-- The job deletes agent_run_events and agent_messages older than one year, in id pages, selecting
-- "created_at < cutoff". Neither table has an index that leads with created_at (their existing
-- indexes lead with run_id / conversation_id), so without these every page would scan the table.
--
-- Additive and optional: the job is correct without them, only slower, so the code can ship before
-- this is applied. No table change, no backfill.
--
-- Aurora DSQL rules followed: ASYNC index builds, one DDL statement per transaction, no foreign keys.

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_run_events_created_at ON agent_run_events(created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_messages_created_at ON agent_messages(created_at);
