-- Migration 068: direct workspace scope on solutions and objectives
-- (ADR "Thinking-model presets and typed links", Phase 0, decisions 3-4).
--
-- Solution was scoped only through opportunities.workspace_id and Objective only
-- through okr_cycles.workspace_id, so every tenant check walked a parent chain.
-- This adds workspace_id to both tables so authorization can read the row's own
-- column. The DDL here is the schema half; the data half (batched backfill from
-- the parent, then the zero-NULL / parent-agreement postconditions) runs in the
-- runner hook in lib/migrations/workspace-id-on-solution-objective.ts BEFORE
-- this migration's receipt is recorded.
--
-- Aurora DSQL rules followed:
--   - No foreign key (relationMode = "prisma"): integrity is application-level.
--   - One DDL per statement; every index is CREATE INDEX ASYNC (the runner waits
--     on the async job, see ASYNC_WAIT_MIGRATIONS).
--   - No constraint on ADD COLUMN. DSQL rejects NOT NULL / DEFAULT on ADD COLUMN
--     and has no ALTER COLUMN SET NOT NULL, so the columns stay nullable at the
--     database. NOT NULL is enforced in the application instead: every write path
--     sets the value from the authorized parent, and every read path treats a
--     NULL workspace_id as "deny". The migration postcondition proves zero NULLs
--     at the moment of the receipt.
--   - IF NOT EXISTS everywhere so a resumed or repeated run is a no-op.

ALTER TABLE solutions ADD COLUMN IF NOT EXISTS workspace_id UUID;
ALTER TABLE objectives ADD COLUMN IF NOT EXISTS workspace_id UUID;
CREATE INDEX ASYNC IF NOT EXISTS idx_solutions_workspace_id ON solutions (workspace_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_objectives_workspace_id ON objectives (workspace_id);
