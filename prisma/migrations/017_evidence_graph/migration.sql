-- Migration 017: Evidence Graph
-- Adds the polymorphic `evidence` table — attaches a piece of customer
-- signal (interview, feedback, support ticket, experiment result, or
-- analytics) to exactly one of an opportunity, solution, or assumption.
-- The "exactly one parent" invariant is enforced in application code
-- (lib/evidence-tool-handlers.ts) since DSQL has no CHECK constraints.
--
-- DSQL rules:
--   No FK constraints in DDL — opportunity_id/solution_id/assumption_id
--   are plain UUID columns, relations are enforced by Prisma (relationMode
--   = "prisma") and application code only.
--   Indexes are created ASYNC.

CREATE TABLE evidence (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID         NOT NULL,
  source_type    VARCHAR(50)  NOT NULL,
  excerpt        TEXT         NOT NULL,
  source_url     VARCHAR(2048),
  confidence     VARCHAR(50)  NOT NULL DEFAULT 'medium',
  opportunity_id UUID,
  solution_id    UUID,
  assumption_id  UUID,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX ASYNC idx_evidence_workspace_id   ON evidence (workspace_id);
CREATE INDEX ASYNC idx_evidence_opportunity_id ON evidence (opportunity_id);
CREATE INDEX ASYNC idx_evidence_solution_id    ON evidence (solution_id);
CREATE INDEX ASYNC idx_evidence_assumption_id  ON evidence (assumption_id);
