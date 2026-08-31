BEGIN;
CREATE TABLE IF NOT EXISTS "review_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "gate_type" VARCHAR(50) NOT NULL,
  "subject_type" VARCHAR(50) NOT NULL,
  "subject_id" UUID NOT NULL,
  "state" VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  "current_revision_id" UUID,
  "revision_count" INTEGER NOT NULL DEFAULT 0,
  "requested_by_id" UUID,
  "assigned_to_id" UUID,
  "due_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "review_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_review_requests_subject_gate" UNIQUE ("workspace_id", "gate_type", "subject_type", "subject_id"),
  CONSTRAINT "idx_review_requests_current_revision" UNIQUE ("current_revision_id")
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "review_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "request_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "summary" TEXT,
  "packet_json" TEXT NOT NULL,
  "required_role" VARCHAR(30) NOT NULL DEFAULT 'ADMIN',
  "expires_at" TIMESTAMP(3),
  "superseded_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "review_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_review_revisions_request_number" UNIQUE ("request_id", "revision_number"),
  CONSTRAINT "idx_review_revisions_request_fingerprint" UNIQUE ("request_id", "fingerprint")
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "review_options" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "revision_id" UUID NOT NULL,
  "action_key" VARCHAR(50) NOT NULL,
  "label" VARCHAR(120) NOT NULL,
  "outcome_class" VARCHAR(30) NOT NULL,
  "continuation_key" VARCHAR(80) NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "review_options_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_review_options_revision_action" UNIQUE ("revision_id", "action_key")
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "decision_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "option_id" UUID NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "actor_role" VARCHAR(30) NOT NULL,
  "rationale" TEXT,
  "idempotency_key" VARCHAR(128) NOT NULL,
  "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "decision_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_decision_records_revision" UNIQUE ("revision_id"),
  CONSTRAINT "idx_decision_records_idempotency" UNIQUE ("idempotency_key")
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "decision_applications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "decision_id" UUID NOT NULL,
  "continuation_key" VARCHAR(80) NOT NULL,
  "target_type" VARCHAR(50) NOT NULL,
  "target_id" UUID NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  "receipt_key" VARCHAR(160) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "applied_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "decision_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_decision_applications_receipt" UNIQUE ("receipt_key"),
  CONSTRAINT "idx_decision_applications_decision_continuation" UNIQUE ("decision_id", "continuation_key")
);
COMMIT;

BEGIN;
ALTER TABLE "roadmap_items" ADD COLUMN IF NOT EXISTS "now_commitment_provenance" VARCHAR(30);
COMMIT;

BEGIN;
UPDATE "roadmap_items"
SET "now_commitment_provenance" = 'LEGACY_UNGATED'
WHERE "now_commitment_provenance" IS NULL;
COMMIT;

BEGIN;
ALTER TABLE "roadmap_items" ALTER COLUMN "now_commitment_provenance" SET DEFAULT 'LEGACY_UNGATED';
COMMIT;

BEGIN;
ALTER TABLE "roadmap_items" ALTER COLUMN "now_commitment_provenance" SET NOT NULL;
COMMIT;

BEGIN;
ALTER TABLE "roadmap_items" ADD COLUMN IF NOT EXISTS "now_decision_record_id" UUID;
COMMIT;

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
