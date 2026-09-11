-- Forward-only repair for the exact partial state left by the failed Preview
-- execution of 039. The runner verifies the pre-existing shape, skips the
-- named CHECK only when its catalog semantics match, backfills in bounded
-- batches, waits for every async job, and verifies postconditions before
-- recording this superseding receipt.
BEGIN;
ALTER TABLE "roadmap_items" ADD COLUMN IF NOT EXISTS "now_commitment_provenance" VARCHAR(30);
COMMIT;

BEGIN;
ALTER TABLE "roadmap_items" ALTER COLUMN "now_commitment_provenance" SET DEFAULT 'LEGACY_UNGATED';
COMMIT;

BEGIN;
ALTER TABLE "roadmap_items" ADD COLUMN IF NOT EXISTS "now_decision_record_id" UUID;
COMMIT;

BEGIN;
ALTER TABLE "roadmap_items" ADD CONSTRAINT "chk_roadmap_items_commitment_provenance_not_null" CHECK ("now_commitment_provenance" IS NOT NULL) NOT VALID;
COMMIT;

ALTER TABLE ASYNC "roadmap_items" VALIDATE CONSTRAINT "chk_roadmap_items_commitment_provenance_not_null";

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_review_requests_workspace_state" ON "review_requests" ("workspace_id", "state");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_review_revisions_request_id" ON "review_revisions" ("request_id");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_review_options_revision_id" ON "review_options" ("revision_id");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_decision_records_workspace_decided" ON "decision_records" ("workspace_id", "decided_at");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_decision_records_request_id" ON "decision_records" ("request_id");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_decision_records_option_id" ON "decision_records" ("option_id");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_decision_applications_target" ON "decision_applications" ("target_type", "target_id");
COMMIT;
