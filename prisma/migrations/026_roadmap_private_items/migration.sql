-- Migration 026: private roadmap items
-- Adds a per-item visibility flag so items (e.g. security fixes, sensitive
-- internal work) can be excluded from the public portal roadmap and voting
-- while remaining fully visible on the internal Board/Timeline.
-- DSQL rules:
--   ALTER TABLE ADD COLUMN must NOT include NOT NULL constraints
--   Backfill existing rows explicitly, then treat the column as non-null at
--   the application layer (Prisma schema still declares it non-optional
--   with a default, since new rows always supply a value).

BEGIN;
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS is_private BOOLEAN;
COMMIT;

BEGIN;
UPDATE roadmap_items SET is_private = false WHERE is_private IS NULL;
COMMIT;
