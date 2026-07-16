-- Migration 015: roadmap item start/end dates (Timeline / Gantt view)
-- DSQL rules:
--   ALTER TABLE ADD COLUMN must NOT include NOT NULL constraints
--   No FK constraints in DDL (relationMode = "prisma" enforces at app layer)

ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS start_date TIMESTAMP(3);
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS end_date TIMESTAMP(3);
