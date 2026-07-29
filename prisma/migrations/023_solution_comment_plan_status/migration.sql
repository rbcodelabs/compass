-- Migration 023: Solution Comment Plan Status
-- Adds an approve/reject status to Plan & Discussion entries. Only
-- meaningful on PLAN rows (the pinned "current plan") — COMMENT rows just
-- carry the default and are never surfaced with a status in the UI.
-- Purely a status marker: approving/rejecting has no side effects on the
-- parent Solution's status.
--
-- DSQL rules:
--   ALTER TABLE ADD COLUMN must NOT include NOT NULL or DEFAULT constraints.
--   Backfill via UPDATE ... WHERE col IS NULL, then treat the app-level
--   default ('PENDING', set in schema.prisma) as authoritative for new rows.

ALTER TABLE solution_comments ADD COLUMN IF NOT EXISTS plan_status VARCHAR(20);
UPDATE solution_comments SET plan_status = 'PENDING' WHERE plan_status IS NULL;
