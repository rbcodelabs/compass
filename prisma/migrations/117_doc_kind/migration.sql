-- Migration 117: what a Doc is in the Library (docs.kind).
-- Additive: one nullable column on docs, no default, no backfill, no index, no foreign key, no enum (DSQL rules, see 075/112/113).
--   kind  VARCHAR(30)  NULL = "no type", every existing row's state. The allowed values (ADR, QA_REPORT, DESIGN, NOTE) live in
--                      lib/doc-kinds.ts, not in the database, so a new kind needs no migration. Independent of doc_type.
-- Code ships before this applies: nothing reads or writes the column until it exists. Existing rows get their kind from the explicit-only
-- data migration 118_doc_kind_backfill, which a person runs on purpose.
-- No dedicated index: the Library lists a workspace's docs (idx_docs_seq leads with workspace_id) and groups them in memory.

ALTER TABLE docs ADD COLUMN IF NOT EXISTS kind VARCHAR(30);
