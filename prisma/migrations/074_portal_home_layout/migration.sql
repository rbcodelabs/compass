-- Migration 074: Portal Home widget layout (one row per workspace).
-- Additive: one new table and one unique async index. No existing table changes
-- and no data backfill (the table starts empty; a workspace with no row, or with
-- no published layout, renders the code-defined default home).
--
-- Aurora DSQL rules followed:
--   - No foreign keys: workspace_id / published_by_id are bare UUID columns,
--     validated in application code.
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - The index is CREATE UNIQUE INDEX ASYNC, with no ASC/DESC and no partial index.
--   - No trigger: updated_at is set by the application on every write.
--
-- draft_widgets is the admin's work in progress; published_widgets is what
-- customers see (NULL until the first publish). Both hold a JSON array of
-- widgets {id, type, size, order, config, visibility}, validated with Zod in
-- application code on every write and again on every read.

CREATE TABLE IF NOT EXISTS portal_home_layouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  draft_widgets JSONB NOT NULL DEFAULT '[]'::jsonb,
  published_widgets JSONB,
  published_at TIMESTAMP(3),
  published_by_id UUID,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_portal_home_layouts_workspace ON portal_home_layouts(workspace_id);
