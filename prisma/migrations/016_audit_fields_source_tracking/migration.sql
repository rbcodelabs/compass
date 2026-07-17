-- Migration 016: audit fields + source tracking
-- Adds created_by_id, updated_by_id, and source to the 13 mutable content
-- models so we can attribute writes to a user and distinguish UI vs API/MCP
-- origin.
--
-- DSQL rules:
--   ALTER TABLE ADD COLUMN must NOT include NOT NULL or DEFAULT constraints
--   New CREATE TABLE statements can have defaults fine
--   No FK constraints in DDL

-- ── assumptions ───────────────────────────────────────────────────────────────
ALTER TABLE assumptions ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE assumptions ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE assumptions ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE assumptions SET source = 'UI' WHERE source IS NULL;

-- ── check_ins ─────────────────────────────────────────────────────────────────
ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE check_ins SET source = 'UI' WHERE source IS NULL;

-- ── custom_field_definitions ─────────────────────────────────────────────────
ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE custom_field_definitions SET source = 'UI' WHERE source IS NULL;

-- ── docs ──────────────────────────────────────────────────────────────────────
ALTER TABLE docs ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE docs ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE docs ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE docs SET source = 'UI' WHERE source IS NULL;

-- ── experiment_results ───────────────────────────────────────────────────────
ALTER TABLE experiment_results ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE experiment_results ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE experiment_results ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE experiment_results SET source = 'UI' WHERE source IS NULL;

-- ── experiments ───────────────────────────────────────────────────────────────
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE experiments SET source = 'UI' WHERE source IS NULL;

-- ── feedback ──────────────────────────────────────────────────────────────────
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE feedback SET source = 'UI' WHERE source IS NULL;

-- ── key_results ───────────────────────────────────────────────────────────────
ALTER TABLE key_results ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE key_results ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE key_results ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE key_results SET source = 'UI' WHERE source IS NULL;

-- ── objectives ────────────────────────────────────────────────────────────────
ALTER TABLE objectives ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE objectives ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE objectives ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE objectives SET source = 'UI' WHERE source IS NULL;

-- ── opportunities ─────────────────────────────────────────────────────────────
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE opportunities SET source = 'UI' WHERE source IS NULL;

-- ── roadmap_items ─────────────────────────────────────────────────────────────
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE roadmap_items SET source = 'UI' WHERE source IS NULL;

-- ── solutions ─────────────────────────────────────────────────────────────────
ALTER TABLE solutions ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE solutions ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE solutions ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE solutions SET source = 'UI' WHERE source IS NULL;

-- ── squads ────────────────────────────────────────────────────────────────────
ALTER TABLE squads ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE squads ADD COLUMN IF NOT EXISTS updated_by_id UUID;
ALTER TABLE squads ADD COLUMN IF NOT EXISTS source VARCHAR(20);
UPDATE squads SET source = 'UI' WHERE source IS NULL;
