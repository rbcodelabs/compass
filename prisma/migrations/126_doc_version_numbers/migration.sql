-- Migration 126: doc_versions.version_number, the v1, v2, v3 number of a version pinned for a decision request.
-- Additive and nullable (no default: DSQL). NULL means an ordinary auto or named snapshot, which stays unnumbered.
ALTER TABLE doc_versions ADD COLUMN IF NOT EXISTS version_number INTEGER;
