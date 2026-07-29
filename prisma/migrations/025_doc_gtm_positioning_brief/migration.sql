-- Migration 025: Doc GTM Positioning & Messaging Brief support
-- Adds two nullable columns to the existing docs table so a Doc can be
-- linked 1:1 to a RoadmapItem as its Positioning & Messaging Brief.
--
-- DSQL rules:
--   ALTER TABLE ADD COLUMN must NOT include NOT NULL/DEFAULT (per
--   014_feedback_type) — add nullable, backfill with UPDATE, let Prisma's
--   schema-level @default cover new rows going forward.
--   No FK constraints in DDL — roadmap_item_id is a plain UUID column;
--   the relation is enforced by Prisma (relationMode = "prisma") and
--   application code only.
--   Indexes are created ASYNC. A unique index on a nullable column is safe
--   here — NULLs don't collide.

ALTER TABLE docs ADD COLUMN IF NOT EXISTS roadmap_item_id UUID;
ALTER TABLE docs ADD COLUMN IF NOT EXISTS doc_type VARCHAR(50);

UPDATE docs SET doc_type = 'STANDARD' WHERE doc_type IS NULL;

CREATE UNIQUE INDEX ASYNC docs_roadmap_item_id_key ON docs (roadmap_item_id);
