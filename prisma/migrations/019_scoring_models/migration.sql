-- Migration 019: Scoring Models
-- Adds org-level scoring model templates (e.g. RICE, ICE) that workspaces
-- can activate to rank opportunities on a comparable 0-100 scale.
--
-- Four tables:
--   scoring_models             — org-owned named templates (WEIGHTED_SUM or
--                                 MULTIPLICATIVE formula), archive-only.
--   scoring_model_metrics      — the metrics that make up a template's formula.
--   workspace_scoring_configs  — which template (if any) a workspace has active.
--   opportunity_scores         — a saved score per opportunity, with a frozen
--                                 snapshot of the formula + model version so
--                                 historical scores survive later template edits.
--
-- DSQL rules:
--   No FK constraints in DDL — organization_id/scoring_model_id/workspace_id/
--   opportunity_id are plain UUID columns; relations are enforced by Prisma
--   (relationMode = "prisma") and application code only.
--   No JSON/JSONB columns — formula_snapshot and raw_values are stored as TEXT
--   (JSON-encoded) and parsed in application code.
--   Indexes are created ASYNC.

CREATE TABLE scoring_models (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID          NOT NULL,
  name            VARCHAR(255)  NOT NULL,
  description     TEXT,
  status          VARCHAR(50)   NOT NULL DEFAULT 'ACTIVE',
  formula_type    VARCHAR(50)   NOT NULL DEFAULT 'WEIGHTED_SUM',
  version         INTEGER       NOT NULL DEFAULT 1,
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE scoring_model_metrics (
  id               UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  scoring_model_id UUID              NOT NULL,
  key              VARCHAR(50)       NOT NULL,
  label            VARCHAR(255)      NOT NULL,
  description      TEXT,
  min_value        DOUBLE PRECISION  NOT NULL DEFAULT 0,
  max_value        DOUBLE PRECISION  NOT NULL DEFAULT 10,
  weight           DOUBLE PRECISION  NOT NULL DEFAULT 1,
  direction        VARCHAR(10)       NOT NULL DEFAULT 'POSITIVE',
  "order"          INTEGER           NOT NULL DEFAULT 0
);

CREATE TABLE workspace_scoring_configs (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID          NOT NULL,
  scoring_model_id UUID,
  created_at       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE opportunity_scores (
  id                 UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id     UUID              NOT NULL,
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

CREATE INDEX ASYNC scoring_models_organization_id_idx ON scoring_models (organization_id);
CREATE UNIQUE INDEX ASYNC scoring_model_metrics_scoring_model_id_key_key ON scoring_model_metrics (scoring_model_id, key);
CREATE UNIQUE INDEX ASYNC workspace_scoring_configs_workspace_id_key ON workspace_scoring_configs (workspace_id);
CREATE UNIQUE INDEX ASYNC opportunity_scores_opportunity_id_key ON opportunity_scores (opportunity_id);
CREATE INDEX ASYNC opportunity_scores_scoring_model_id_idx ON opportunity_scores (scoring_model_id);
