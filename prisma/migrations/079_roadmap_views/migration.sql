-- Migration 079: saved roadmap views.
-- Additive: one new table and one non-unique async index. No existing table changes
-- and no backfill (a user with no saved views simply sees the built-in default view).
--
-- Aurora DSQL rules followed:
--   - No foreign keys: organization_id / workspace_id / owner_id are bare UUID columns,
--     validated in application code.
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - The index is CREATE INDEX ASYNC, with no ASC/DESC and no partial index.
--   - No trigger: updated_at is set by the application on every write.
--
-- A view lives on one surface:
--   workspace_id IS NULL     -> the org-level, cross-workspace roadmap (/{org}/roadmap)
--   workspace_id IS NOT NULL -> that workspace's own roadmap (/{org}/{workspace}/roadmap)
-- visibility is PERSONAL (owner only) or SHARED (every member who can reach that surface).
-- Sharing never widens data access: the roadmap items a view returns are always re-scoped
-- to the workspaces the viewer can read at query time.
--
-- filters and display are JSON documents validated with Zod in application code on every
-- write and again on every read (an unparseable stored document degrades to the default
-- view instead of failing the page).

CREATE TABLE IF NOT EXISTS roadmap_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  workspace_id UUID,
  owner_id UUID NOT NULL,
  name VARCHAR(120) NOT NULL,
  visibility VARCHAR(20) NOT NULL DEFAULT 'PERSONAL',
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  display JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ASYNC IF NOT EXISTS idx_roadmap_views_org_surface ON roadmap_views(organization_id, workspace_id);
