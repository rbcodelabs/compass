-- Migration 092: human-readable work item IDs, schema half (ADR "Human-readable work item IDs").
-- Gives 14 work item tables a per-workspace, per-type number: seq_prefix (OPP, TASK, ...) and
-- seq_number, unique per (workspace_id, seq_prefix, seq_number). Numbers come from the new
-- workspace_sequences counter, allocated inside the creating transaction (lib/work-item-sequence.ts).
-- The data half (numbering existing rows) is migration 093, run explicitly after the allocating code
-- is live. Until a row is numbered, both columns are NULL, and NULLs never collide in a unique index.
--
-- key_results and assumptions never carried workspace_id (they reach it through objective and
-- solution), so they get a nullable one here; 093 backfills it from the parent.
--
-- Aurora DSQL rules followed:
--   - No foreign keys: integrity is application-level.
--   - One DDL per statement; every statement is idempotent (IF NOT EXISTS).
--   - ADD COLUMN carries no NOT NULL or DEFAULT (DSQL rejects both on a populated table); NOT NULL is
--     the application's job and the 093 postcondition proves zero NULL seq_number at its receipt.
--   - Every index is CREATE [UNIQUE] INDEX ASYNC with no ASC/DESC and no partial predicate; the runner
--     waits on the async job (ASYNC_WAIT_MIGRATIONS).
--   - No trigger: workspace_sequences.updated_at is set by the application.

ALTER TABLE key_results ADD COLUMN IF NOT EXISTS workspace_id UUID;

ALTER TABLE assumptions ADD COLUMN IF NOT EXISTS workspace_id UUID;

ALTER TABLE objectives ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE objectives ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE key_results ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE key_results ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE solutions ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE solutions ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE assumptions ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE assumptions ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE experiments ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE experiments ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE feedback ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE feedback ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE docs ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE docs ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE research_studies ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE research_studies ADD COLUMN IF NOT EXISTS seq_number INTEGER;

ALTER TABLE metric_definitions ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8);

ALTER TABLE metric_definitions ADD COLUMN IF NOT EXISTS seq_number INTEGER;

-- Counter: one row per (workspace, entity type). next_value is the next number to hand out.
CREATE TABLE IF NOT EXISTS workspace_sequences (
  workspace_id UUID NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, entity_type)
);

CREATE INDEX ASYNC IF NOT EXISTS idx_key_results_workspace_id ON key_results(workspace_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_assumptions_workspace_id ON assumptions(workspace_id);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_objectives_seq ON objectives(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_key_results_seq ON key_results(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_opportunities_seq ON opportunities(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_solutions_seq ON solutions(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_assumptions_seq ON assumptions(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_experiments_seq ON experiments(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_tasks_seq ON tasks(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_roadmap_items_seq ON roadmap_items(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_feedback_seq ON feedback(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_review_requests_seq ON review_requests(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_docs_seq ON docs(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_artifacts_seq ON artifacts(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_research_studies_seq ON research_studies(workspace_id, seq_prefix, seq_number);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_metric_definitions_seq ON metric_definitions(workspace_id, seq_prefix, seq_number);
