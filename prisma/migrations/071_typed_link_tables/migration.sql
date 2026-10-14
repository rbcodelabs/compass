-- Migration 071: typed link tables (ADR "Thinking-model presets and typed links",
-- Phase 2, PR-1, migration only).
--
-- Two dedicated tables replace the single nullable opportunities.linked_key_result_id
-- pointer with many-to-many links:
--   opportunity_objective_links   Opportunity <-> Objective
--   solution_key_result_links     Solution    <-> Key Result
--
-- This PR creates the tables and backfills Opportunity <-> Objective only;
-- Solution <-> Key Result starts empty. NOTHING reads or writes these tables yet:
-- the code that does arrives in a later PR and must not deploy before this
-- migration is applied. linked_key_result_id is left untouched.
--
-- The DDL here is the schema half. The data half (precondition that 068 is
-- applied, batched backfill with orphan quarantine, then the integrity
-- postconditions) runs in the runner hook in lib/migrations/typed-link-tables.ts
-- BEFORE this migration's receipt is recorded.
--
-- Aurora DSQL rules followed:
--   - No foreign keys (relationMode = "prisma"): integrity is application-level
--     and is proven for the backfilled rows by the hook's postconditions.
--   - One DDL statement per statement; every index is CREATE INDEX ASYNC (the
--     runner waits on each async job and checks indisvalid, see ASYNC_WAIT_MIGRATIONS).
--   - The tables are created empty, so workspace_id can be NOT NULL from the start
--     (DSQL forbids adding NOT NULL to an existing column, but a new table is fine).
--   - IF NOT EXISTS everywhere so a resumed or repeated run is a no-op.

CREATE TABLE IF NOT EXISTS opportunity_objective_links (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  origin VARCHAR(20) NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'UI',
  created_by_id UUID,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS solution_key_result_links (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL,
  solution_id UUID NOT NULL,
  key_result_id UUID NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'UI',
  created_by_id UUID,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_opportunity_objective_links_pair ON opportunity_objective_links (opportunity_id, objective_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_opportunity_objective_links_objective ON opportunity_objective_links (objective_id, opportunity_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_opportunity_objective_links_workspace ON opportunity_objective_links (workspace_id);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_solution_key_result_links_pair ON solution_key_result_links (solution_id, key_result_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_solution_key_result_links_key_result ON solution_key_result_links (key_result_id, solution_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_solution_key_result_links_workspace ON solution_key_result_links (workspace_id);
