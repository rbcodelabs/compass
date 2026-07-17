-- Migration 018: Workspace Branding
-- Adds optional per-workspace branding fields: an accent color (preset
-- palette id or a custom hex), a font (preset id or a custom Google Font
-- family name), and a logo URL. All columns are nullable and additive —
-- existing workspaces with no branding set are unaffected.
--
-- DSQL rules:
--   No FK constraints in DDL.
--   No CREATE TYPE, no @default(autoincrement()).
--   Indexes (none needed here) would be created ASYNC.

ALTER TABLE workspaces ADD COLUMN branding_palette_id     VARCHAR(50);
ALTER TABLE workspaces ADD COLUMN branding_primary_hex    VARCHAR(7);
ALTER TABLE workspaces ADD COLUMN branding_font_preset_id VARCHAR(50);
ALTER TABLE workspaces ADD COLUMN branding_font_family    VARCHAR(100);
ALTER TABLE workspaces ADD COLUMN branding_logo_url       TEXT;
