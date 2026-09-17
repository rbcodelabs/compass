-- Migration 053: shared field option sets
--
-- Adds the generic "shared select options" primitive so a SELECT/MULTI_SELECT
-- CustomFieldDefinition can reference a workspace-level named option set
-- instead of holding its own independent options array. First consumer:
-- "Product Area" tagging across Opportunity/Solution/RoadmapItem/Task, but
-- this table is not specific to that use case.
--
-- DSQL rules followed:
--   - UUID PK via gen_random_uuid(), no SERIAL.
--   - No FK constraint from custom_field_definitions.shared_option_set_id to
--     shared_field_option_sets — relationMode=prisma, validated in app code,
--     consistent with every other cross-table reference in this schema.
--   - No @updatedAt — updated_at is set explicitly in app code.
--   - ADD COLUMN is nullable, no DEFAULT, no backfill: every existing
--     custom_field_definitions row gets NULL, meaning "not using a shared
--     set" — exactly today's behavior, unchanged.
--   - Indexes are ASYNC, the only form DSQL supports. The runner rewrites
--     ASYNC away when DATABASE_URL signals local PostgreSQL.
--   - Each statement below runs in its own transaction per the runner.
--
-- Numbered 053, not 052: ADR-0012 (Accepted) states that the repository
-- already contains duplicate migration numbers and further duplicates should
-- be avoided. #234 took 052 for 052_research_evidence_promotion, so this one
-- continues the sequence rather than adding a fourth duplicate pair.
--
-- Index rationale: the unique index on (workspace_id, name) is not an
-- optimization, it is the uniqueness constraint the Prisma model declares, so
-- it has to exist regardless of table size. The lookup index on
-- custom_field_definitions(shared_option_set_id) backs the delete guard
-- ("N fields use this set") and the detach path, both of which query by set id
-- on every settings render.

CREATE TABLE IF NOT EXISTS shared_field_option_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  options JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_id UUID,
  updated_by_id UUID,
  source VARCHAR(20) NOT NULL DEFAULT 'UI'
);

ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS shared_option_set_id UUID;

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_shared_field_option_sets_workspace_name ON shared_field_option_sets (workspace_id, name);

CREATE INDEX ASYNC IF NOT EXISTS idx_custom_field_definitions_shared_option_set ON custom_field_definitions (shared_option_set_id);
