BEGIN;
CREATE TABLE IF NOT EXISTS "decision_evidence_refs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "review_revision_id" UUID NOT NULL,
  "evidence_type" VARCHAR(80) NOT NULL,
  "authority_provider" VARCHAR(30) NOT NULL,
  "authority_record_id" VARCHAR(255) NOT NULL,
  "authority_locator" TEXT NOT NULL,
  "authority_checksum" CHAR(64) NOT NULL,
  "subject_type" VARCHAR(50) NOT NULL,
  "subject_id" UUID NOT NULL,
  "decision_outcome" VARCHAR(50) NOT NULL,
  "decision_source_version" VARCHAR(80) NOT NULL,
  "application_status" VARCHAR(30) NOT NULL,
  "applied_at" TIMESTAMP(3) NOT NULL,
  "application_receipt_id" VARCHAR(255) NOT NULL,
  "verified_at" TIMESTAMP(3) NOT NULL,
  "verifier_version" VARCHAR(80) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "decision_evidence_refs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_decision_evidence_refs_revision_authority" UNIQUE ("review_revision_id", "evidence_type", "authority_record_id")
);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_decision_evidence_refs_subject" ON "decision_evidence_refs" ("subject_type", "subject_id", "evidence_type");
COMMIT;
