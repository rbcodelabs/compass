-- Migration 055: Workspace launch-workflow flag
--
-- Adds a nullable Boolean column to workspaces gating the entire
-- marketing-launch surface: launch tiers/checklists, the LAUNCHING/LAUNCHED
-- roadmap horizons, the roadmap-item panel's Launch section, the roadmap
-- card's launch chip/menu item, positioning briefs (GTM_POSITIONING_BRIEF
-- docType), and the related MCP tools. Defaults to false/off for every
-- workspace -- confirmed zero roadmap items currently sit in LAUNCHING or
-- LAUNCHED anywhere in the Compass workspace, so this default is
-- non-destructive. See Claude/2026-07-21-compass-gtm-planning-design.md for
-- original context and Compass feedback item eb7b9850-1129-45c9-887f-
-- b41de21bdf4a for the request to make this optional.
--
-- DSQL rules followed (matching the established pattern in 009_feedback_voting,
-- 013_portal_auth, and 020_portal_sso for the other workspace boolean flags):
--   - Plain ALTER TABLE ADD COLUMN, no FK, no index, no CREATE TYPE.
--   - IF NOT EXISTS for idempotent reruns.
--   - No DEFAULT clause on ADD COLUMN: DSQL rejects any constraint on it
--     ("ALTER TABLE ADD COLUMN with constraint not supported"), confirmed
--     live against the preview environment. Instead, add the column nullable
--     then backfill every existing row to false with a separate UPDATE, so
--     existing workspaces land on explicit "off" rather than NULL. Prisma's
--     `@default(false)` in schema.prisma only applies at the ORM layer for
--     new `create()` calls, not as DDL.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS launch_workflow_enabled BOOLEAN;
UPDATE workspaces SET launch_workflow_enabled = false WHERE launch_workflow_enabled IS NULL;
