-- Migration 054: Workspace WIP limits (NOW/NEXT)
--
-- Adds two nullable Int columns to workspaces for the NOW/NEXT roadmap
-- column WIP limits. Purely visual/advisory settings — no enforcement, no
-- validation, no blocking behavior anywhere in the app (see
-- docs/decisions/0005-compass-native-decision-gates.md and 0006, both
-- Superseded, which retired the old runtime enforcement machinery this must
-- not regrow). NULL means "no limit set"; there is deliberately no default.
--
-- DSQL rules followed:
--   - Plain ALTER TABLE ADD COLUMN, no FK, no index, no CREATE TYPE.
--   - Nullable with no DEFAULT: every existing workspace row gets NULL,
--     i.e. today's "no limit" behavior, unchanged.
--   - IF NOT EXISTS for idempotent reruns.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS now_limit INTEGER;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS next_limit INTEGER;
