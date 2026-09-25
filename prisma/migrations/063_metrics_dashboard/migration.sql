-- Migration 062: Metrics dashboard layout
--
-- Adds workspace-level dashboard layout state to MetricDefinition, backing
-- the new standalone /metrics page (a grid of resizable/draggable metric
-- widget cards). Layout is shared by everyone viewing the workspace, not
-- per-user -- consistent with the rest of Compass having no per-user board
-- personalization.
--
-- DSQL rules followed (matching the established pattern in
-- 054_workspace_wip_limits and 055_workspace_launch_workflow_flag):
--   - Plain ALTER TABLE ADD COLUMN, no FK, no index, no CREATE TYPE.
--   - IF NOT EXISTS for idempotent reruns.
--   - No DEFAULT clause on ADD COLUMN: DSQL rejects any constraint on it
--     ("ALTER TABLE ADD COLUMN with constraint not supported"). Instead, add
--     each column nullable then backfill every existing row with a separate
--     UPDATE, so existing metrics land on an explicit default (visible, a
--     medium-sized card, default sort order) rather than NULL. Prisma's
--     `@default(...)` in schema.prisma only applies at the ORM layer for new
--     `create()` calls, not as DDL -- every reader still coalesces NULL to
--     the same default (see lib/analytics/service.ts).

ALTER TABLE metric_definitions ADD COLUMN IF NOT EXISTS dashboard_visible BOOLEAN;
UPDATE metric_definitions SET dashboard_visible = true WHERE dashboard_visible IS NULL;
ALTER TABLE metric_definitions ADD COLUMN IF NOT EXISTS dashboard_col INTEGER;
UPDATE metric_definitions SET dashboard_col = 2 WHERE dashboard_col IS NULL;
ALTER TABLE metric_definitions ADD COLUMN IF NOT EXISTS dashboard_row INTEGER;
UPDATE metric_definitions SET dashboard_row = 4 WHERE dashboard_row IS NULL;
ALTER TABLE metric_definitions ADD COLUMN IF NOT EXISTS dashboard_sort_order INTEGER;
UPDATE metric_definitions SET dashboard_sort_order = 0 WHERE dashboard_sort_order IS NULL;
