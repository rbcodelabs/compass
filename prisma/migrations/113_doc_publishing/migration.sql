-- Migration 113: publish individual Docs to the customer portal.
-- Additive: two nullable columns on docs, no default, no backfill, no index (DSQL rules, see 075/112).
--   published_at     TIMESTAMP(3)  NULL = private to workspace members (every existing row's state).
--                                  Set = the doc is readable on the public portal. Cleared = unpublished.
--   published_by_id  UUID          the member who last published it (bare UUID, no foreign key).
-- No dedicated index: public reads always lead with workspace_id, which idx_docs_seq already serves, and a
-- workspace holds few docs. A partial index is not available on DSQL.

ALTER TABLE docs ADD COLUMN IF NOT EXISTS published_at TIMESTAMP(3);
ALTER TABLE docs ADD COLUMN IF NOT EXISTS published_by_id UUID;
