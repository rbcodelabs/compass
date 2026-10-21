-- Migration 100: per-workspace monotonic doc change log and its seq counter (Geode doc sync spike, ADR "Compass as a
-- Geode Sync Provider", rollout step 1).
-- Additive and empty: two new tables and one unique index. Rows are only written while
-- DOCS_SYNC_ENABLED is on, so the code can ship before or after this is applied. No backfill.
--
-- One row is a change to a STANDARD doc:
--   seq      -> per-workspace monotonic sequence, taken from doc_change_counters (one row per
--               workspace, locked then incremented in the mutation's transaction); the
--               unique index is a backstop against duplicates
--   kind     -> UPSERT | MOVE | DELETE
--   revision -> the doc revision after the change
--   epoch (counter) -> random per workspace log; scan cursors embed it so a rebuilt log invalidates them
--   dirty (counter) -> a doc was written while sync was off (epoch rotated); cleared by the next logged write
--   path     -> the doc's virtual path when recorded (last path for DELETE)
--
-- Aurora DSQL rules followed:
--   - No foreign keys: doc_id and workspace_id are bare UUIDs validated in application code.
--   - No sequence or SERIAL: seq is allocated by the application from the counter row.
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

CREATE TABLE IF NOT EXISTS doc_change_counters (
  workspace_id UUID PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  epoch VARCHAR(36) NOT NULL,
  dirty BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_doc_changes_workspace_seq ON doc_changes(workspace_id, seq);
