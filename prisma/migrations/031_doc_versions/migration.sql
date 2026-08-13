-- Migration 031: Doc Version History
-- Adds a DocVersion table: point-in-time snapshots of a Doc's content, taken
-- automatically right before an overwriting save (coalesced, see
-- lib/doc-versions.ts) or explicitly via a "named" manual snapshot.
--
-- DSQL rules:
--   No FK constraints in DDL — doc_id is a plain UUID column; the relation
--   is enforced by Prisma (relationMode = "prisma") and application code
--   only.
--   No CREATE TYPE, no @default(autoincrement()).
--   Indexes are created ASYNC.

CREATE TABLE doc_versions (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id          UUID          NOT NULL,
  title           VARCHAR(255)  NOT NULL,
  content         TEXT,
  metadata        JSON,
  icon            VARCHAR(50),
  label           VARCHAR(100),
  created_by_id   UUID,
  created_by_name VARCHAR(255),
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ASYNC doc_versions_doc_id_created_at_idx ON doc_versions (doc_id, created_at);
