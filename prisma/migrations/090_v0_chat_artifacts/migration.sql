-- V0_CHAT artifacts: a v0 chat id on the artifact and a v0 version marker on
-- each revision, so "Refresh from v0" can tell whether v0 has something new.
-- Both columns are nullable with no DEFAULT (DSQL forbids DEFAULT on ADD COLUMN).
BEGIN;
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "v0_chat_id" VARCHAR(100);
COMMIT;

BEGIN;
ALTER TABLE "artifact_revisions" ADD COLUMN IF NOT EXISTS "v0_version_id" VARCHAR(200);
COMMIT;
