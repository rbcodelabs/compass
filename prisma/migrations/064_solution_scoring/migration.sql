-- Migration 064: Solution Scoring
-- Adds a second, independent scoring slot so a workspace can select one
-- scoring model for Opportunities (existing, unchanged) and a separate one
-- for Solutions, both drawn from the same org-level scoring_models library
-- (migration 019). Additive only:
--   workspace_scoring_configs gains solution_scoring_model_id. The existing
--   scoring_model_id column is kept as-is at the DB level (no rename) — the
--   Prisma field it maps to was renamed to opportunityScoringModelId, but
--   that is an application-layer change only, with no backfill required.
--   solution_scores is a structural mirror of opportunity_scores (019),
--   scoped to Solutions instead.
--
-- DSQL rules (matching 019's conventions exactly):
--   No FK constraints in DDL — solution_id/scoring_model_id are plain UUID
--   columns; relations are enforced by Prisma (relationMode = "prisma") and
--   application code only.
--   No JSON/JSONB columns — formula_snapshot and raw_values are stored as
--   TEXT (JSON-encoded) and parsed in application code.
--   Indexes are created ASYNC.

ALTER TABLE workspace_scoring_configs ADD COLUMN solution_scoring_model_id UUID;

CREATE TABLE solution_scores (
  id                 UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id        UUID              NOT NULL,
  scoring_model_id   UUID              NOT NULL,
  model_version      INTEGER           NOT NULL,
  formula_snapshot   TEXT              NOT NULL,
  raw_values         TEXT              NOT NULL,
  raw_score          DOUBLE PRECISION  NOT NULL,
  normalized_score   DOUBLE PRECISION  NOT NULL,
  scored_at          TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scored_by_user_id  UUID,
  created_at         TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC solution_scores_solution_id_key ON solution_scores (solution_id);
CREATE INDEX ASYNC solution_scores_scoring_model_id_idx ON solution_scores (scoring_model_id);
