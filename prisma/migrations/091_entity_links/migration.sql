-- Migration 091: one generic entity_links table for association links (ADR "One generic
-- entity_links table for association links", phase 1).
-- Additive and empty: one new table and three indexes. Nothing reads or writes it yet, so the
-- code can ship before or after this is applied. No backfill.
--
-- One row is a typed, directed link between two entities of the same workspace:
--   link_type   -> the association (for example OPPORTUNITY_OBJECTIVE)
--   from_*/to_* -> the two endpoints (entity type name plus UUID)
--   origin      -> DIRECT, or how the row came to exist when it is not a direct edit
--   source      -> UI, API, AGENT, ... (who created it)
--   attrs       -> optional JSON text for link-specific attributes
--
-- Aurora DSQL rules followed:
--   - No foreign keys: every *_id column is a bare UUID validated in application code.
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - Indexes are CREATE [UNIQUE] INDEX ASYNC, with no ASC/DESC and no partial index.
--   - No trigger: updated_at is set by the application on every write.

CREATE TABLE IF NOT EXISTS entity_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  link_type VARCHAR(60) NOT NULL,
  from_type VARCHAR(40) NOT NULL,
  from_id UUID NOT NULL,
  to_type VARCHAR(40) NOT NULL,
  to_id UUID NOT NULL,
  origin VARCHAR(20) NOT NULL DEFAULT 'DIRECT',
  source VARCHAR(20) NOT NULL DEFAULT 'UI',
  created_by_id UUID,
  attrs TEXT,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_entity_links_pair ON entity_links(from_id, link_type, to_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_entity_links_reverse ON entity_links(to_id, link_type, from_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_entity_links_workspace ON entity_links(workspace_id, link_type);
