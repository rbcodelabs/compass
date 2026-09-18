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
-- DSQL rules followed:
--   - Plain ALTER TABLE ADD COLUMN, no FK, no index, no CREATE TYPE.
--   - IF NOT EXISTS for idempotent reruns.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS launch_workflow_enabled BOOLEAN DEFAULT false;
