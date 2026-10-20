-- Migration 092: per-workspace monotonic doc change log (Geode doc sync spike, ADR "Compass as a
-- Geode Sync Provider", rollout step 1).
-- Additive and empty: one new table and one unique index. Rows are only written while
-- DOCS_SYNC_ENABLED is on, so the code can ship before or after this is applied. No backfill.
--
-- One row is a change to a STANDARD doc:
--   seq      -> per-workspace monotonic sequence (application allocates max(seq)+1 in the same
--               transaction as the doc mutation; the unique index rejects a concurrent duplicate)
--   kind     -> UPSERT | MOVE | DELETE
--   revision -> the doc revision after the change
--   path     -> the doc's virtual path when recorded (last path for DELETE)
--
-- Aurora DSQL rules followed:
--   - No foreign keys: doc_id and workspace_id are bare UUIDs validated in application code.
--   - No sequence or SERIAL: seq is allocated by the application.
--   - One idempotent DDL statement each; the index is CREATE UNIQUE INDEX ASYNC with no ASC/DESC
--     and no partial predicate.

CREATE TABLE IF NOT EXISTS doc_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  doc_id UUID NOT NULL,
  seq INTEGER NOT NULL,
  kind VARCHAR(10) NOT NULL,
  revision VARCHAR(80),
  path TEXT NOT NULL,
  deleted_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_doc_changes_workspace_seq ON doc_changes(workspace_id, seq);
