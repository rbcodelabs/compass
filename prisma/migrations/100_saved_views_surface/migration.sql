-- Migration 100: saved views, surface discriminator (ADR "Generic saved views with board column layout", step 2).
-- (The ADR proposed number 098; 098 and 099 were already taken, so this is 100.)
--
-- Expand only. roadmap_views keeps its name and its ids (so ?saved=<id> links keep working); the Prisma model is
-- renamed SavedView and mapped onto it. One nullable column says which surface a row belongs to:
--   OPPORTUNITIES_BOARD | SOLUTIONS_BOARD | ROADMAP_WORKSPACE | ROADMAP_ORG
-- NULL = a legacy row written before this migration (or by old code mid-rollout). Application code reads it as
-- ROADMAP_ORG when workspace_id IS NULL, otherwise ROADMAP_WORKSPACE, so nothing depends on the backfill having run.
--
-- The backfill is NOT in this file: it is the hook in lib/migrations/saved-views-surface.ts, run by the migration
-- runner after these statements and before the receipt. It only touches rows where surface IS NULL, in bounded
-- batches (idempotent and resumable), and the postcondition proves the column, the index and that no NULL surface
-- remains.
--
-- Aurora DSQL rules followed:
--   - No foreign keys, no triggers.
--   - ADD COLUMN carries no DEFAULT and no NOT NULL (non-null is an application invariant). OPEN QUESTION: DSQL
--     support for a nullable ADD COLUMN on this existing table is not yet confirmed in the work deployment.
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - The index is CREATE INDEX ASYNC, with no ASC/DESC and no partial index.

ALTER TABLE roadmap_views ADD COLUMN IF NOT EXISTS surface VARCHAR(40);

CREATE INDEX ASYNC IF NOT EXISTS idx_roadmap_views_org_surface_kind ON roadmap_views(organization_id, workspace_id, surface);
