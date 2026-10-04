-- Migration 075: roadmap item provenance for "build the roadmap from Discovery".
--
-- Adds two nullable columns to roadmap_items:
--   auto_created        BOOLEAN        TRUE when auto-sync created the item because
--                                      its solution reached Building. An ARCHIVED row
--                                      with this flag is the suppression marker: once a
--                                      user removes or undoes an auto-created item,
--                                      auto-sync never re-adds it for that solution.
--   schedule_edited_at  TIMESTAMP(3)   set when a human edits the item's dates or
--                                      horizon. While NULL, a linked item's horizon and
--                                      dates follow its solution; afterwards they stop.
--
-- NULL means "not auto-created" / "schedule never edited by hand", which is exactly
-- the state of every existing row, so there is no backfill.
--
-- DSQL rules followed:
--   - Plain ALTER TABLE ADD COLUMN, one DDL per statement. No index, no foreign
--     key, no CHECK.
--   - No DEFAULT and no NOT NULL on ADD COLUMN: DSQL rejects any constraint on it.
--   - IF NOT EXISTS so a resumed or repeated run is a no-op.

ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS auto_created BOOLEAN;
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS schedule_edited_at TIMESTAMP(3);
