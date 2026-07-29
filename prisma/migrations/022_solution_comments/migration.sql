-- Migration 022: Solution Comments (Plan & Discussion)
-- Adds a SolutionComment table backing the Plan & Discussion thread on each
-- Solution: PLAN entries (a later one supersedes the previous "current plan")
-- and COMMENT replies, postable from both the UI and MCP tools.
--
-- DSQL rules:
--   No FK constraints in DDL — solution_id is a plain UUID column;
--   the relation is enforced by Prisma (relationMode = "prisma") and
--   application code only.
--   No CREATE TYPE, no @default(autoincrement()).
--   Indexes are created ASYNC.

CREATE TABLE solution_comments (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id  UUID          NOT NULL,
  comment_type VARCHAR(20)   NOT NULL DEFAULT 'COMMENT',
  body         TEXT          NOT NULL,
  author_name  VARCHAR(255)  NOT NULL,
  author_type  VARCHAR(20)   NOT NULL DEFAULT 'HUMAN',
  source       VARCHAR(20)   NOT NULL DEFAULT 'UI',
  created_at   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ASYNC solution_comments_solution_id_idx ON solution_comments (solution_id);
