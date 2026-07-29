-- Migration 022: Canvas Node Positions
-- Adds a CanvasNodePosition table for the /canvas pan/zoom viewer (Phase 1,
-- see Claude/compass-canvas-viewer-design-2026-07-21.md §8). Ships unpopulated
-- this phase — no drag-to-pin UI yet — so Phase 2's layout logic doesn't need
-- a retrofit migration.
--
-- DSQL rules:
--   No FK constraints in DDL — workspace_id is a plain UUID column; the
--   relation is enforced by Prisma (relationMode = "prisma") and application
--   code only.
--   No CREATE TYPE, no @default(autoincrement()).
--   Indexes are created ASYNC.

CREATE TABLE canvas_node_positions (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID          NOT NULL,
  entity_type    VARCHAR(50)   NOT NULL,
  entity_id      UUID          NOT NULL,
  x              DOUBLE PRECISION NOT NULL,
  y              DOUBLE PRECISION NOT NULL,
  pinned         BOOLEAN       NOT NULL DEFAULT true,
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by_id  UUID
);

CREATE UNIQUE INDEX ASYNC canvas_node_positions_workspace_entity_idx
  ON canvas_node_positions (workspace_id, entity_type, entity_id);
