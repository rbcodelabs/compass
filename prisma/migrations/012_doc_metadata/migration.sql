-- Add metadata JSON column to docs table
-- Stores YAML frontmatter key-value pairs extracted from doc content.
-- NULL for docs with no frontmatter.

BEGIN;
ALTER TABLE "docs" ADD COLUMN IF NOT EXISTS "metadata" JSON;
COMMIT;
