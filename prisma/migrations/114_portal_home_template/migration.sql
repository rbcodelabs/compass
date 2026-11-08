-- Migration 114: selectable Portal Home template.
-- Additive: two nullable columns on portal_home_layouts, no default, no backfill, no index (DSQL rules, see 075/112).
--   draft_template      VARCHAR(20)  the template the admin is editing.
--   published_template  VARCHAR(20)  the template customers see.
-- NULL means "editorial" (the template every existing layout already renders as), so there is no backfill and
-- the application coerces NULL and unknown values to editorial on read. DSQL rejects DEFAULT on ADD COLUMN.

ALTER TABLE portal_home_layouts ADD COLUMN IF NOT EXISTS draft_template VARCHAR(20);
ALTER TABLE portal_home_layouts ADD COLUMN IF NOT EXISTS published_template VARCHAR(20);
