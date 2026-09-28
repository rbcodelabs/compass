-- Migration 065: Org-wide member read-only workspace access flag
--
-- Adds a nullable Boolean column to organizations gating implicit read-only
-- access: when true, every OrganizationMember of that org can read every
-- Workspace the org owns without a WorkspaceMember row (Settings, member
-- management, and billing stay gated on real membership -- this flag only
-- ever widens read access). Default off for every organization.
--
-- DSQL rules followed (matching the established pattern in 055_workspace_launch_workflow_flag
-- and the other single-boolean-flag migrations):
--   - Plain ALTER TABLE ADD COLUMN, no FK, no index, no CREATE TYPE.
--   - IF NOT EXISTS for idempotent reruns.
--   - No DEFAULT clause on ADD COLUMN: DSQL rejects any constraint on it
--     ("ALTER TABLE ADD COLUMN with constraint not supported"). Instead, add
--     the column nullable then backfill every existing row to false with a
--     separate UPDATE, so existing organizations land on explicit "off"
--     rather than NULL. Prisma's `@default(false)` in schema.prisma only
--     applies at the ORM layer for new `create()` calls, not as DDL.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS member_workspace_read_only_access BOOLEAN;
UPDATE organizations SET member_workspace_read_only_access = false WHERE member_workspace_read_only_access IS NULL;
