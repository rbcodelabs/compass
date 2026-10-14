-- Migration 065: Review option description
-- Adds a nullable description to review_options so a tracked decision can carry
-- caller-supplied options (label + optional description) alongside the standard
-- Approve / Request changes / Reject rows. Additive only: existing rows keep a
-- NULL description, which the application treats as "no description".
--
-- DSQL rules followed (matching 055_workspace_launch_workflow_flag):
--   - Plain ALTER TABLE ADD COLUMN: no FK, no index, no CREATE TYPE.
--   - IF NOT EXISTS for idempotent reruns.
--   - No DEFAULT / NOT NULL on ADD COLUMN: DSQL rejects any constraint on it.
--   - TEXT rather than a bounded VARCHAR; the 500-character limit is enforced
--     in application code (lib/tracked-decisions.ts) like the other free text.

ALTER TABLE "review_options" ADD COLUMN IF NOT EXISTS "description" TEXT;
