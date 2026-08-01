-- Migration 027: Tasks
-- Adds the `tasks` table (standalone top-level delivery/tracking entity) and
-- `task_links` (polymorphic many-to-many join to Opportunity, Solution,
-- RoadmapItem, Objective, KeyResult, Doc, Experiment, FeedbackItem).
-- See Claude/compass-task-tracker-design-2026-07-31.md for the full design.
--
-- DSQL rules:
--   No FK constraints in DDL — squad_id/parent_task_id/assignee_user_id/
--   linked_id are plain UUID columns, relations are enforced by Prisma
--   (relationMode = "prisma") and application code only.
--   Indexes are created ASYNC.
--   One DDL statement per transaction — each CREATE TABLE / CREATE INDEX
--   below must be applied as its own statement.

CREATE TABLE tasks (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID         NOT NULL,
  squad_id         UUID,
  parent_task_id   UUID,
  title            VARCHAR(255) NOT NULL,
  description      TEXT,
  status           VARCHAR(50)  NOT NULL DEFAULT 'TODO',
  priority         VARCHAR(20)  NOT NULL DEFAULT 'MEDIUM',
  assignee_user_id UUID,
  owner_name       VARCHAR(255),
  story_points     DOUBLE PRECISION,
  due_date         TIMESTAMPTZ,
  iteration        VARCHAR(100),
  sort_order       INTEGER      NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by_id    UUID,
  updated_by_id    UUID,
  source           VARCHAR(20)  NOT NULL DEFAULT 'UI'
);

CREATE TABLE task_links (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID         NOT NULL,
  linked_type   VARCHAR(30)  NOT NULL,
  linked_id     UUID         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by_id UUID,
  source        VARCHAR(20)  NOT NULL DEFAULT 'UI'
);

CREATE UNIQUE INDEX ASYNC idx_task_links_task_linked_unique ON task_links (task_id, linked_type, linked_id);

CREATE INDEX ASYNC idx_tasks_workspace_status  ON tasks (workspace_id, status);
CREATE INDEX ASYNC idx_tasks_squad_id          ON tasks (squad_id);
CREATE INDEX ASYNC idx_tasks_parent_task_id    ON tasks (parent_task_id);
CREATE INDEX ASYNC idx_tasks_assignee_user_id  ON tasks (assignee_user_id);
CREATE INDEX ASYNC idx_task_links_linked       ON task_links (linked_type, linked_id);
