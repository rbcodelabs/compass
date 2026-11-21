-- Migration 129: link an assistant message to the agent run that produced it (ADR-0032, TASK-40).
-- Additive: one nullable column and one async index. Nothing existing changes.
--
-- Why: a detached run records its cost on agent_runs AND on the assistant message it creates, with nothing joining
-- the two, so summing both tables double-counts. run_id lets spend be defined once: run cost, plus message cost
-- only where run_id IS NULL (inline turns, and every message that predates this column).
--
-- Apply BEFORE deploying code that selects agent_messages: the Prisma model now maps run_id, so a read without an
-- explicit select asks for a column that does not exist until this runs.
--
-- Aurora DSQL rules followed: no foreign key (bare UUID validated in code), idempotent statements, CREATE INDEX ASYNC
-- with no ASC/DESC, no backfill (legacy rows stay NULL; windows that include them are reported as partial).

ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS run_id UUID;

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_messages_run ON agent_messages(run_id);
